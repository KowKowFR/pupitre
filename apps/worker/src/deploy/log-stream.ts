import {
  deployChannel,
  stripAnsi,
  type DeployEvent,
  type DeployLogLine,
  type DeployMessage,
  type DeploymentStepKey,
} from '@tp/core';
import { appendStepLog } from '@tp/db';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

/**
 * Diffusion des logs de déploiement.
 *
 * Deux destinations, une seule source :
 *   - Redis pub/sub, pour le direct via SSE ;
 *   - `deployment_steps.log`, pour la relecture après coup.
 *
 * Les écritures en base sont regroupées : une ligne de `docker compose pull`
 * toutes les 30 ms ferait autant d'UPDATE, ce qui noierait la base pour rien.
 *
 * **On publie après avoir persisté, jamais l'inverse.** L'ordre importe : le
 * pub/sub Redis n'a pas d'historique, et un client qui se branche ne peut
 * rattraper le passé que par la base. Publier d'abord ouvrirait une fenêtre —
 * large de tout l'intervalle de regroupement — où une ligne est déjà partie sur
 * le canal mais pas encore écrite : le nouvel arrivant la manque des deux côtés
 * et la perd définitivement. En publiant après l'écriture, on garantit
 * « diffusé ⇒ durable », et la couture historique/direct devient sûre par
 * construction plutôt que par chance.
 *
 * Le prix est un retard d'au plus `FLUSH_INTERVAL_MS` sur le direct. Pour un
 * journal de déploiement, c'est imperceptible.
 */

const FLUSH_INTERVAL_MS = 400;
const FLUSH_THRESHOLD = 40;

export class DeployLogStream {
  private buffers = new Map<DeploymentStepKey, string[]>();
  /**
   * Les mêmes lignes, à plat et dans l'ordre d'émission — les tampons par étape
   * servent l'écriture groupée, celui-ci sert la diffusion, qui doit rester
   * globalement ordonnée même quand deux étapes parlent dans le même lot.
   */
  private pendingPublish: DeployMessage[] = [];
  /**
   * Toutes les publications passent par cette chaîne. Sans elle, un événement
   * de fin publié pendant qu'un lot de lignes s'écrit encore doublerait ces
   * lignes et fermerait le flux avant qu'elles n'arrivent.
   */
  private publishQueue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly channel: string;
  /**
   * Dernière ligne émise par étape.
   *
   * `docker compose` redessine ses lignes de progression : privé de TTY, il
   * réémet le même texte plusieurs fois d'affilée (« Network … Creating »
   * apparaît deux fois). Une fois les séquences ANSI retirées, ces redessins
   * deviennent des doublons stricts et consécutifs — on les écarte ici, à la
   * source, plutôt que de les persister puis de les rejouer.
   */
  private lastLine = new Map<DeploymentStepKey, string>();

  constructor(
    private readonly deploymentId: string,
    private readonly publisher: Redis,
  ) {
    this.channel = deployChannel(deploymentId);
  }

  /** Émet une ligne : mise en tampon, puis base et Redis au prochain lot. */
  line(step: DeploymentStepKey, text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const cleaned = stripAnsi(text).replace(/\r$/, '');
    if (cleaned.trim().length === 0) return;
    if (this.lastLine.get(step) === cleaned) return;
    this.lastLine.set(step, cleaned);

    const payload: DeployLogLine = {
      ts: new Date().toISOString(),
      step,
      stream,
      line: cleaned,
    };

    this.pendingPublish.push({ kind: 'log', payload });

    const buffer = this.buffers.get(step) ?? [];
    buffer.push(JSON.stringify(payload));
    this.buffers.set(step, buffer);

    if (buffer.length >= FLUSH_THRESHOLD) {
      void this.flush();
    } else {
      this.schedule();
    }
  }

  /**
   * Émet un changement d'état. Non persisté : la base porte déjà l'état.
   *
   * Vide d'abord ce qui attend, pour qu'un événement n'arrive jamais avant les
   * lignes qui le précèdent — l'événement terminal ferme le flux côté client.
   */
  event(event: Omit<DeployEvent, 'ts'>): void {
    const message: DeployMessage = {
      kind: 'event',
      payload: { ts: new Date().toISOString(), ...event },
    };
    void this.flush().then(() => {
      this.enqueuePublish([message]);
    });
  }

  /** Sérialise les publications pour que l'ordre d'émission soit préservé. */
  private enqueuePublish(messages: readonly DeployMessage[]): void {
    if (messages.length === 0) return;
    const batch = [...messages];
    this.publishQueue = this.publishQueue.then(async () => {
      for (const message of batch) {
        try {
          await this.publisher.publish(this.channel, JSON.stringify(message));
        } catch (error) {
          logger.warn({ err: error, channel: this.channel }, 'publication Redis impossible');
        }
      }
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  /** Écrit en base tout ce qui est en attente. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const pending = [...this.buffers.entries()].filter(([, lines]) => lines.length > 0);
    this.buffers.clear();
    const toPublish = this.pendingPublish;
    this.pendingPublish = [];

    for (const [step, lines] of pending) {
      try {
        await appendStepLog(this.deploymentId, step, `${lines.join('\n')}\n`);
      } catch (error) {
        // La ligne ne sera pas relisible après coup, mais la taire priverait
        // aussi le spectateur en cours. On diffuse quand même, et l'avertissement
        // garde trace de la perte de durabilité.
        logger.warn(
          { err: error, deploymentId: this.deploymentId, step },
          "journal d'étape non persisté",
        );
      }
    }

    this.enqueuePublish(toPublish);
  }

  async close(): Promise<void> {
    await this.flush();
    // La chaîne de publication porte le dernier lot : l'attendre évite de
    // couper la connexion Redis avant qu'il ne soit parti.
    await this.publishQueue;
  }
}
