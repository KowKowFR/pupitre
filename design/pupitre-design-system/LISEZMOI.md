# Pupitre · Design system

Le nouveau design system de **Pupitre**, un plan de contrôle auto-hébergé qui déploie vos applications sur vos machines, par SSH, en Docker Compose ou en K3s, à partir de la même description.

## Contenu

- `png/` : les 50 planches à taille réelle (1440 px de large), plus 24 captures d'états ouverts (`*-drawer.png`, `*-palette.png`, `*-purge.png`…).
- `canvas/` : les sources des planches (`*.dc.html`), l'index `canvas.json` et `support.js`, le moteur qui les affiche.
- `tokens/` :
  - `pupitre.css` : tous les jetons clair et sombre, avec les classes de composants.
  - `tailwind-theme.css` : le thème Tailwind v4 prêt à coller.
  - `tokens.json` : les mêmes jetons en JSON.
- `brand/` : le logo en SVG et PNG (tuile outremer, sombre, graphite, glyphe seul), `favicon.svg`, `favicon-32.png` et `apple-touch-icon.png`.
- `KIT.md` : les règles du système. `DATA.md` : les données d'exemple.
- `CLAUDE_CODE_PROMPT.md` : le prompt de migration à donner à Claude Code.

## Ouvrir les planches en local

Les planches doivent passer par un petit serveur local : un double-clic sur le fichier ne suffit pas.

    cd canvas
    python3 -m http.server 8000

Ouvrez ensuite http://localhost:8000/Main.dc.html (le sommaire, avec des liens vers toutes les planches).

Les polices (Instrument Sans et Geist Mono) sont chargées depuis Google Fonts. Sans connexion internet, le navigateur affiche une police de secours.

## Planches jouables (26)

- **Écrans de l'application** : dans tous, ⌘K (le bouton « Rechercher, lancer… ») ouvre la palette, qui se filtre au clavier. Ajoutez `›` en tête de saisie pour ne garder que les commandes.
- **Cibles, Applications, Déploiements, Sondes, Journal** : un clic sur une ligne ouvre le drawer animé.
- **Dialogues** : purge, destruction, seuils, cadence, réinitialisation du 2FA, passer ou quitter l'assistant.
- **Toasts** : ils ont une barre de minuterie de 5 s.
- **FoundMotion** : un bac à sable pour toutes les animations.
