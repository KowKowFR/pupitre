# Pupitre design system · KIT

## Concept

Un pupitre porte la partition. Ici, l'AppSpec est la partition, et Docker Compose ou K3s l'interprètent. Le logo est un P dont la panse est le plateau incliné d'un lutrin, avec deux lignes de partition.

## Jetons

- **Gammes.** Graphite (N0 à N950) et outremer (O50 à O900).
- **Jetons sémantiques** : `bg`, `bg-subtle`, `surface`, `surface-2`, `surface-3`, `border`, `border-strong`, `text`, `text-2`, `text-3`, `accent`, les tons `ok`, `warn`, `danger` et `idle` (chacun avec ses variantes `-soft`, `-line` et `-text`), `sev-*` et `term-*`.
- **Deux thèmes complets.** Le thème sombre s'active avec la classe `.dark`. Le choix Système, Clair ou Sombre se fait dans le menu utilisateur.
- **Rayons** : 4, 6, 8, 12 et 14 px, plus `999` pour les pastilles.
- **Ombres** : `xs` (cartes), `sm` (élément actif), `md` (menus et toasts), `lg` (drawer et dialogue).
- **Mouvement.**
  - Courbes : entrée `cubic-bezier(.16,1,.3,1)`, sortie `cubic-bezier(.5,0,.75,0)`, standard `cubic-bezier(.2,0,0,1)`.
  - Durées : 120, 180, 240 et 320 ms.
  - Le drawer entre en 320 ms, avec ses sections en cascade tous les 40 ms, et sort en 200 ms.
  - Le dialogue et la palette entrent en 240 ms. Les toasts ont une minuterie de 5 s.

## Typographie

- **Instrument Sans** pour l'UI. Les titres sont légèrement condensés (largeur 88 à 96 %).
- **Geist Mono** pour les identifiants.
- **Échelle** :

  | Rôle | Taille / interligne |
  |---|---|
  | Légende | 12/16 |
  | Tableaux | 13/20 |
  | Corps | 14/20 |
  | Section | 15/22 |
  | Titre | 18/26 |
  | Drawer | 20/28 |
  | Page | 24/32 |
  | Relevé | 26/32 |
  | Titre des planches de documentation | 48/52 |

## Coquille

| Zone | Dimensions |
|---|---|
| Rail | 240 px |
| Barre haute | 52 px, avec fil d'Ariane, worker et aide |
| Contenu | 1200 px au plus, padding 28/32 |
| Drawer | 540 px (680 en large), inset 8 |
| Dialogue | 460 px |
| Palette | 640 px |

## Invariants

1. La couleur dit un état, jamais une catégorie. L'outremer sert à l'interaction et à ce qui est en cours.
2. Tout état se lit sans couleur : une led a un libellé, un badge a un texte, un graphique a un résumé.
3. Les identifiants sont en mono.
4. Un bouton désactivé dit pourquoi, en clair.
5. Une action destructive passe par un dialogue qui liste ses conséquences. Détruire demande de retaper le nom.
6. Ce qu'une permission interdit disparaît : ce n'est pas grisé.
7. Une seule action primaire par zone.
8. Chaque écran doit tenir en français comme en anglais.
9. `prefers-reduced-motion` est respecté.
10. L'aperçu s'ouvre dans un drawer, le travail long se fait sur une page. ⌘K est disponible partout.
