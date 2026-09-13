<!--
Merci. Ce modèle est court exprès : ce qu'il demande, c'est ce que la revue
regardera de toute façon. Supprimez les sections sans objet.
Guide complet : CONTRIBUTING.md
-->

## Ce que ça change

<!-- Deux ou trois phrases. L'effet, pas la liste des fichiers touchés. -->

Ferme #

## Ce que j'ai lancé

<!--
Collez la SORTIE RÉELLE, pas une case cochée. « Ça marche chez moi » n'est pas
une vérification. Le socle est celui de la CI :
-->

```
pnpm build:packages
pnpm -r typecheck
pnpm exec tsc --noEmit -p scripts/tsconfig.json
pnpm --filter @pupitre/web lint
pnpm --filter @pupitre/core test
pnpm test:schedule
pnpm test:ai
```

<!--
Et les scripts de vérification concernés par ce que vous touchez, avec leur
dernière ligne. Si vous n'avez pas pu en lancer un — pas de cible, pas de
cluster, pas de clé d'IA — DITES-LE ici plutôt que de l'omettre.
-->

## Les règles du projet

- [ ] Aucun `if (runtime === ...)` de plus hors des drivers.
      `grep -rn "runtime === '" apps packages --include='*.ts' --include='*.tsx' | grep -v /drivers/ | grep -v /dist/`
      rend toujours la même unique ligne connue, pas une de plus.
- [ ] Aucune opération longue dans une route HTTP : ça passe par BullMQ.
- [ ] Le journal d'activité passe par `logAudit()`, pas par un insert dispersé.
- [ ] Aucun secret en clair — ni en base, ni dans les logs, ni dans une réponse
      d'API, ni dans ce diff.
- [ ] Aucune migration existante n'a été modifiée, renommée ni supprimée. Les
      nouvelles ont été relues à la main.
- [ ] Une nouvelle route protégée passe par `requirePermission()`.
- [ ] La documentation concernée est à jour dans cette même pull request.

## Ce qui manque, ou ce dont je ne suis pas sûr

<!--
Une pull request honnête sur ses trous se relit mieux qu'une pull request
silencieuse. Ce que vous n'avez pas pu vérifier, ce que vous soupçonnez, ce que
vous avez laissé pour plus tard : c'est ici.
-->
