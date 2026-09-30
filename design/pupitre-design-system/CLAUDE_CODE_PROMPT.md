# Prompt Claude Code : migrer Pupitre vers le nouveau design system

> Copiez tout ce qui suit dans Claude Code, à la racine du dépôt Pupitre.
> Placez d'abord le dossier `pupitre-design-system/` (le zip décompressé) dans `design/`, à la racine du dépôt.

---

Tu vas migrer l'interface de **Pupitre** vers son nouveau design system. Pupitre est un plan de contrôle auto-hébergé qui déploie des applications sur des machines, par SSH, en Docker Compose ou en K3s, à partir d'une AppSpec.

Il s'agit d'une **refonte visuelle et d'interaction**. La logique métier, les API, les server actions, les permissions, les routes et le schéma de base de données ne changent pas. Si une maquette semble exiger un changement de logique, arrête-toi et signale-le au lieu de l'inventer.

## 0. Sources de vérité (lis-les avant d'écrire du code)

| Fichier | Rôle |
|---|---|
| `design/pupitre-design-system/tokens/pupitre.css` | Référence complète : jetons clair et sombre, plus toutes les classes de composants. C'est le comportement attendu, pixel près. |
| `design/pupitre-design-system/tokens/tailwind-theme.css` | Thème Tailwind v4 prêt à l'emploi : variables, `@theme inline`, keyframes, reduced-motion. |
| `design/pupitre-design-system/tokens/tokens.json` | Les mêmes jetons en JSON. |
| `design/pupitre-design-system/png/*.png` | Les 50 planches à taille réelle. Les fichiers `*-drawer.png`, `*-palette.png`, `*-purge.png`… montrent les états ouverts. **Ouvre le PNG de chaque écran avant de le coder.** |
| `design/pupitre-design-system/canvas/*.dc.html` | Les sources des planches : HTML lisible avec les textes exacts, les classes et les structures. Utile pour copier un libellé ou une structure. |
| `design/pupitre-design-system/KIT.md` | Règles du système en prose. |
| `design/pupitre-design-system/brand/` | Logo (SVG et PNG), favicon, apple-touch-icon. |

Planches clés par écran :

| Écran | Planches |
|---|---|
| `/` | `AppDashboard`, `AppDashboardDark` |
| `/targets` | `AppTargets` (+ `-drawer`, `-drawer-warn`, `-palette`) |
| `/targets/:id` | `AppTarget` |
| `/applications` | `AppApplications` (+ `-drawer`, `-delete`) |
| `/applications/new` | `AppAppNew` |
| `/apps` | `AppSupervision` (+ `-thresholds`) |
| `/apps/:id` | `AppConsole` (+ `-destroy`) |
| `/deployments` | `AppDeployments` (+ `-drawer`, `-drawer-live`, `-purge`) |
| `/deployments/:id` | `AppDeployment` |
| `/monitors` | `AppMonitors` |
| `/monitors/:id` | `AppMonitor` |
| `/jobs` | `AppJobs` (+ `-cadence`) |
| `/admin/logs` | `AppLogs` |
| `/admin/users` | `AppUsers` |
| `/admin/roles` | `AppRoles` |
| `/admin/settings` | `SetOverview`, `SetNotifications` |
| `/account` | `AppAccount` |
| `/login` et tout le groupe accès | `AuthSignIn`, `AuthTotp`, `AuthFlows` |
| `/onboarding` | `AppOnboarding` |
| États de chargement, vides, erreurs | `StateLoading`, `StateEmpty`, `StateErrors` |
| Mobile | `MobScreens` |

Composants : `CompButtons`, `CompForms`, `CompSelection`, `CompBadges`, `CompData`, `CompNav`, `CompOverlays`, `CompDrawer`, `CompPalette`, `CompFeedback`, `CompCharts`, `CompTerminal`. Patterns : `PatPrinciples`, `PatPermissions`, `PatDestructive`.

## 1. Direction (à respecter strictement)

- **Couleurs.** Graphite froid pour la structure, **outremer `#2E44D6`** (sombre : `#7F92FF`) pour l'interaction, la sélection et ce qui est « en cours ». Le vert, l'ambre et le rouge sont réservés à l'état, jamais à la décoration. L'ancien jeton `signal` (bleu pétrole) disparaît.
- **Typographie.**
  - **Instrument Sans** pour l'UI. Les titres utilisent `font-stretch: 88–96 %` et un interlettrage négatif.
  - **Geist Mono** pour tout identifiant : slug, hôte, port, version, date, clé de permission, log.
  - IBM Plex Sans, IBM Plex Sans Condensed et JetBrains Mono sont supprimées.
  - Charge les deux polices avec `next/font/google` : `Instrument_Sans` avec les axes `wdth` et `wght`, `Geist_Mono`.
- **Plus de surtitres en capitales** (eyebrow). Le fil d'Ariane de la barre haute les remplace. L'étiquette d'un relevé est en casse de phrase.
- **Densité.** Corps à 14 px, tableaux à 13 px, légendes à 12 px. Le titre de page passe à 24/32, celui d'un drawer à 20/28.
- **Rayons.** 8 px pour les contrôles, 12 px pour les cartes, 14 px pour les drawers et les dialogues, 6 px pour les badges.
- **Logo.** Remplace le carré signal par la tuile Pupitre (`brand/pupitre-mark.svg`) dans le rail, les écrans d'accès, le favicon et les e-mails.

## 2. Mise en place (phase 1)

1. Intègre `tailwind-theme.css` dans `app/globals.css`, en remplacement des jetons OKLCH actuels. Garde les noms shadcn attendus (`--background`, `--foreground`, `--primary`, `--border`, `--ring`…) comme **alias** des nouveaux jetons, pour que les primitives existantes continuent de compiler :

   ```css
   :root {
     --background: var(--bg);
     --foreground: var(--text);
     --card: var(--surface);
     --primary: var(--accent);
     --primary-foreground: #fff;
     --muted: var(--surface-3);
     --muted-foreground: var(--text-3);
     --border: var(--border);
     --input: var(--border-strong);
     --ring: var(--accent);
     --destructive: var(--danger);
   }
   ```

2. **Thème.**
   - Il suit toujours le système par défaut.
   - **Nouveau :** un choix Système / Clair / Sombre dans le menu utilisateur (voir `CompNav`). Il est persisté en cookie et appliqué avec une classe `.dark` ou `.light` sur `<html>`, sans flash au chargement.
   - Le terminal reste sombre dans les deux thèmes.
3. Remplace les polices, le favicon (`brand/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`) et le logo.
4. Supprime les jetons et utilitaires morts de l'ancien système : `signal*`, `ground*`, `ink/muted/faint` et les familles condensées.

## 3. Primitives (phase 2)

Réécris `components/ui/*` d'après `pupitre.css` et les planches Comp*. Garde les API shadcn.

- **Button.**
  - Variantes : `default` (outremer), `secondary`, `ghost`, `destructive` (au trait : texte rouge, bordure rouge pâle), `destructive-solid` (réservée à la confirmation finale d'une destruction), `link`.
  - Tailles : `sm` 28, défaut 32, `lg` 40, `icon` 32. Sur tactile, les cibles font au moins 44 px.
  - Pression : `translateY(.5px) scale(.985)`.
  - Prop `loading` : spinner et libellé « … ».
  - Prop `disabledReason` : quand elle est fournie, le bouton est désactivé et affiche la raison sur une ligne `text-cap text-3` sous la rangée. C'est un invariant.
- **Badge.** 20 px, fond doux et bordure de la même teinte. Variantes `ok`, `warn`, `danger`, `accent`, `outline`, `solid`, `count`. Option `dot`.
- **Led** (nouveau nom de l'ancien voyant). 8 px avec un halo de 3 px de la même teinte à 20 %, via `color-mix`. Tons `ok`, `warn`, `danger`, `accent`, `idle`, `hollow`. `pulse` n'est autorisé que pour « en cours ».
- **Input, Textarea, Select.**
  - Input 34 px, avec focus outremer, anneau de 3 px et état `aria-invalid`.
  - Select natif avec chevron en data-URI.
  - Composants `Field` (label, aide, erreur avec icône) et `SecretInput` (toujours vide en édition, placeholder explicatif, bouton Afficher).
  - `OtpInput` : 6 cases, espacement après la 3ᵉ, `inputmode=numeric`, `autocomplete=one-time-code`.
- **Sélection.** Checkbox 16 px (état mixte inclus), Radio, Switch 32×18 avec la courbe `ease-out`, SegmentedControl, Tabs soulignés en outremer avec compteur, FilterChip avec compteur.
- **Identifiants et étiquettes.** `CodeBadge`, `TargetLabelChip` (teinte dérivée du texte parmi 6 couleurs, jamais vert, ambre ou rouge), `RuntimePill`, `SeverityBadge`.
- **Surfaces.** `Card` (avec `CardHeader`, `CardFooter` en `surface-2`), `Table` (en-tête 36 px en `surface-2`, lignes de 48 px ou 40 en dense, `tr` cliquable, état sélectionné avec un liseré gauche de 2 px en outremer), `KeyValue`, `Readout`, `ReadoutBar`, `EmptyState`, `Skeleton` avec shimmer.

## 4. Couches animées (phase 3, c'est le cœur de la refonte)

Utilise les primitives Radix déjà présentes via shadcn : Dialog, Tooltip, DropdownMenu, Popover. Anime-les avec les attributs `data-state` et les keyframes du thème (`pp-drawer-in/out`, `pp-dialog`, `pp-cmdk`, `pp-pop`, `pp-toast`, `pp-rise`). **Aucune bibliothèque d'animation n'est nécessaire.** Tout doit respecter `prefers-reduced-motion`.

1. **Drawer** (`components/ui/drawer.tsx`, basé sur `Dialog`, voir `CompDrawer` et `AppTargets-drawer.png`).
   - Géométrie : panneau à droite, inset de 8 px, 540 px de large (680 en `wide`), rayon 14, ombre `lg`.
   - Voile : léger (`--scrim-soft`), **sur le contenu seulement** (`left: 240px`). Le rail reste visible.
   - Mouvement : entrée en 320 ms `ease-out` (48 px et fondu), sortie en 200 ms `ease-in`. Les sections du corps apparaissent en cascade (`animation-delay` de 40 ms par enfant, `pp-rise`).
   - En-tête : contexte (icône, type, route en mono), boutons ↑ et ↓ (ligne précédente et suivante, raccourcis K et J), pleine page, fermer (esc). Titre en 20/28, puis une ligne d'état.
   - Pied : action primaire d'abord, lien « Ouvrir la fiche » à droite. Une zone « Zone sensible » en bas du corps accueille les suppressions.
   - État d'URL : synchronise l'élément ouvert dans l'URL (`?target=prod-1`, `?run=127`…) pour permettre partage et bouton précédent.
   - Sous `lg`, le drawer devient une **feuille montante** (voir `MobScreens`).
   - **Où l'utiliser** : aperçu d'une ligne de Cibles, Applications (avec déploiement rapide), Déploiements (pipeline résumé), Sondes, Journal (charge JSON), invitation d'utilisateur, édition d'un canal de notification. Les pages de détail existantes restent : le drawer est un aperçu, la page est le lieu du travail long.
2. **Dialog de confirmation** (`CompOverlays`, `PatDestructive`).
   - Géométrie : 460 px (560 en large), voile de 28 % avec flou de 2 px. Entrée `pp-dialog` en 240 ms, sortie en 160 ms.
   - Contenu : le titre est une question qui nomme l'objet et le lieu. Le corps donne les conséquences en liste à puces. Pied en `surface-2`, avec « Annuler » (ghost) puis le verbe. Le focus initial se place sur Annuler pour un destructif.
   - Trois niveaux : réversible (primaire), perte de trace (destructif au trait), perte de données (champ « Retapez {nom} » et `destructive-solid`, désactivé tant que la saisie ne correspond pas exactement).
3. **Palette ⌘K** (`CompPalette`, `AppTargets-palette.png`). Utilise **`cmdk`**, via le `Command` de shadcn.
   - Ouverture : ⌘K ou Ctrl K partout, plus le bouton « Rechercher, lancer… » en tête du rail. 640 px, à 96 px du haut, entrée `pp-cmdk`.
   - Groupes : Suggestions, Aller à, Objets, Préférences. Un groupe vide est masqué.
   - Recherche d'objets : cibles, applications, runs (`#127`), sondes. Crée une route `GET /api/search?q=` (ou une server action) qui réutilise les requêtes existantes, **filtrées par permission**.
   - Un préfixe `›` ne garde que les commandes.
   - Élément : cartouche d'icône de 28 px, titre, méta, verbe « Ouvrir » ou « Lancer » avec ↵ au survol ou quand il est actif.
   - Une commande interdite n'apparaît pas.
   - Raccourcis globaux : `G` puis `D`, `C`, `A`, `P` ou `S` pour naviguer, `?` pour afficher la liste des raccourcis, `J` et `K` dans les listes.
4. **Tooltip.** Délai de 260 ms, fond `n900` (clair sur sombre), 12/16, entrée de 120 ms. Obligatoire sur chaque bouton icône, avec un `aria-label`. Peut contenir un `Kbd`. **Jamais seul porteur d'une information indispensable.**
5. **Menus et popovers.** Rayon 11, ombre `md`, entrée `pp-pop` en 180 ms. Les items font 32 px, avec un raccourci ou une méta à droite. Un item destructif est rouge et placé en dernier, après un séparateur.
6. **Toasts.** Utilise **`sonner`** (thémé) ou un composant maison.
   - Géométrie : 360 px, en bas à droite. Icône de ton, titre, sous-ligne, action facultative (Suivre, Annuler), bouton fermer.
   - **Barre de minuterie de 5 s** en outremer en pied. Pause au survol. Une erreur reste affichée. Trois toasts au maximum.
   - Le texte reprend le verbe du bouton qui l'a déclenché (« Déploiement enfilé »).

## 5. Coquille (phase 4, voir `CompNav`)

- **Rail**
  - 240 px, fond `bg-subtle`, bordure droite.
  - En tête : bloc d'instance (tuile de 28 px, nom, sous-titre, chevron vers un menu d'instance), puis le bouton de recherche ⌘K.
  - Groupes « Exploitation » (Vue d'ensemble, Cibles, Applications, Supervision, Déploiements, Sondes, Tâches) et « Administration » (Journal, Utilisateurs, Rôles, Paramètres).
  - Item de 32 px. L'état actif utilise le fond `surface`, l'ombre `sm` et une icône outremer. L'ancien plot vertical disparaît.
  - Métas à droite : compteurs, compteur rouge pour les anomalies, led pulsante s'il y a un déploiement en vol.
  - Pied : **carte « Démarrage n sur 7 »** avec barre de progression. Elle remplace le bandeau de reprise, qui apparaissait en tête de chaque page. Puis le bloc utilisateur (avatar, nom, rôle, menu : Mon compte, Thème, Raccourcis, Documentation, Déconnexion).
- **Barre haute**
  - 52 px.
  - Fil d'Ariane à gauche (instance / section / objet).
  - À droite : pastille « Worker actif » (led et info-bulle « dernier battement… »), Documentation, Raccourcis.
- **PageHeader**
  - Titre 24/32, description de 68 caractères au plus par ligne, actions à droite.
  - Plus de surtitre. Le PageHeader actuel perd son eyebrow.
- **Contenu** : padding 28/32, largeur maximale de 1200 px.
- **Sous lg** : barre haute collante et floutée, navigation à plat en défilement horizontal, drawers en feuille montante (`MobScreens`).

## 6. Écrans (phase 5, un par un, en comparant au PNG)

Pour chaque écran : ouvre son PNG et ceux de ses états, reproduis-le avec les primitives, puis vérifie les trois profils (admin, operator, viewer). Changements notables par rapport à aujourd'hui :

- **Vue d'ensemble.**
  - Bloc Attention : liseré gauche rouge, lignes led, sujet en mono, détail et verbe.
  - Carte « Les dernières 24 heures » : 4 relevés, puis 4 pistes sur un axe partagé (RatioBars, SeriesLine avec seuil en tirets, EventRail avec info-bulles).
  - Panneau Machines élargi : sparkline de 240 px, nombre d'apps, runtime, mini-jauges.
  - En marche et Derniers déploiements côte à côte, puis barre d'inventaire.
  - Bouton « Déployer » (raccourci D) qui ouvre la palette.
- **Cibles.**
  - Puces de statut avec compteurs, recherche et étiquettes.
  - Nouvelle colonne « Charge 24 h » (sparkline et mini-jauges).
  - Actions en icônes avec info-bulle.
  - **Clic sur une ligne : drawer.**
  - La suppression est dans la « Zone sensible » du drawer, désactivée avec sa raison.
- **Fiche d'une cible.**
  - Titre avec l'état.
  - Onglets Vue d'ensemble, Charges (n), Ports (n/m), Preflight, Configuration.
  - Bande de 4 relevés, puis Runtimes et Ports (jauge et tableau), puis « Ce qui tourne » et Preflight.
- **Applications.**
  - Interrupteur « Rollback automatique » en tête.
  - Colonne « En service sur ».
  - Drawer avec relecture de la spec et déploiement rapide.
  - Suppression via le dialogue de niveau 3.
- **Nouvelle application.** Deux colonnes : saisie (onglets IA ou JSON, puis déploiement dans la foulée) à gauche, relecture « Ce qui va tourner » et JSON à droite.
- **Supervision.** Une carte par serveur : bande de relevés en `bg-subtle`, alerte de dépassement, tableau des apps. Dialogue Seuils.
- **Console d'app.**
  - Carte « Exploitation » dans l'en-tête.
  - Colonne gauche de 352 px (Services, Mise en ligne, Machine, Sonde).
  - Terminal sombre : barre de titre, barre de filtres séparée, lignes d'erreur avec liseré.
  - **Traduis au passage tous les textes codés en dur en français** : ils doivent passer par l'i18n comme le reste du panel.
- **Déploiements.**
  - Puces de filtre.
  - Barre de sélection outremer (purge).
  - Cases désactivées avec leur raison en info-bulle **et** dans la barre.
  - Drawer du run.
  - Pagination avec boutons.
- **Détail d'un run.**
  - Carte résumé avec une barre de progression de 3 px en pied.
  - Onglets Pipeline, Sécurité, AppSpec figée.
  - Pipeline vertical en `.steps` (réussi en vert, en cours en outremer avec spinner, échoué en rouge avec encart d'erreur, sans objet en pointillés).
  - Terminal à la même hauteur que le pipeline.
- **Sondes.** Liste en cartes-lignes : nom et type, état, frise d'une heure, latence, taux 24 h et 7 j, actions. Bandeau d'incident rouge ou de préavis ambre intégré à la carte.
- **Fiche d'une sonde.** Quatre relevés, puis la latence avec zones sans réponse hachurées (trait coupé), puis la chronologie des incidents (captures avant et pendant).
- **Tâches.** Tableau, puis dialogue Cadence (segmenté Simple ou Expert, jours en pastilles, aperçu des prochaines occurrences).
- **Journal.** Filtres en grille, les refus en badge rouge mono. Clic sur une ligne : drawer avec la charge JSON indentée.
- **Utilisateurs.** Tableau avec avatars et select de rôle en ligne. Invitation dans un drawer (avec l'aperçu « Ce que reçoit… »). Dialogue « Réinitialiser le 2FA ».
- **Rôles.** Cartes dépliables. Les permissions sont groupées en fieldsets, et la case cochée prend le fond `surface-2`.
- **Paramètres.** Navigation de sections de 216 px avec icônes. Le Sommaire est en cartes terme/valeur. Notifications : canaux en liste, édition dans un drawer.
- **Accès.**
  - Coquille à grille de 48 px estompée en ellipse, avec logo et mot-symbole « pupitre ».
  - Carte de 400 px, rayon 14, ombre `md`.
  - OTP en 6 cases.
  - Tous les états sont dans `AuthFlows`.
- **Assistant de démarrage.** En-tête fin, stepper à gauche (pastilles vertes, outremer ou ambre), carte d'étape, dialogues Passer et Quitter.
- **États.** Squelettes à la silhouette exacte (`StateLoading`), états vides avec cartouche d'icône (`StateEmpty`), pages système (`StateErrors`).

## 7. Invariants (à vérifier sur chaque écran, bloquants en revue)

1. Le rouge, l'ambre et le vert ne servent qu'à l'état. L'outremer ne sert qu'à l'interaction, à la sélection et à ce qui est en cours.
2. Tout état se lit sans couleur : une led a toujours un libellé à côté (ou une info-bulle en liste très dense), un badge a un texte, un graphique a un résumé et une table équivalente.
3. Les identifiants techniques sont en Geist Mono.
4. Un bouton désactivé affiche sa raison en clair, pas seulement dans une info-bulle.
5. Toute action destructive passe par un dialogue qui liste ses conséquences. Détruire et Forcer l'effacement demandent de retaper le nom.
6. Ce qu'une permission interdit **disparaît** (rail, boutons, pistes, commandes ⌘K). Rien n'est grisé pour ça.
7. Une seule action primaire par zone.
8. Le français est souvent 15 à 30 % plus long : teste chaque écran en `fr` **et** en `en`.
9. `prefers-reduced-motion` : plus de glissé, plus de shimmer, plus de pulsation.
10. Accessibilité : focus visible (anneau de 3 px), `aria-label` sur les boutons icône, `role="dialog"` et `aria-modal`, piège du focus dans les couches, esc pour fermer, contraste AA (`text-3` est calibré pour 4,5:1).

## 8. Méthode de travail

- Avance **phase par phase**, avec un commit par phase : `feat(ui): tokens & fonts`, `feat(ui): primitives`, `feat(ui): overlays (drawer, dialog, cmdk, toasts)`, `feat(ui): app shell`, puis un commit par écran.
- Avant chaque phase, donne en 5 lignes au plus ce que tu vas toucher. Après chaque écran, fais une capture (Playwright si disponible) et compare-la au PNG de la planche. Liste les écarts restants.
- Ne crée aucune dépendance lourde. Seules `cmdk` et `sonner` sont acceptées si elles sont absentes.
- Garde les tests existants au vert. Ajoute des tests de rendu pour : Button `disabledReason`, masquage par permission du rail et de la palette, Drawer (ouverture et fermeture, esc, synchronisation d'URL), confirmation par saisie du nom.
- Termine par un **rapport** : écrans migrés, écarts assumés, suites proposées.

Commence par la phase 1 : lis les fichiers de tokens et 3 PNG (`AppDashboard`, `AppTargets-drawer`, `CompButtons`), puis propose ton plan de modification de `globals.css` et de la configuration des polices avant d'écrire.
