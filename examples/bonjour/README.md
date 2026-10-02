# Exemple — une application déployée depuis son dépôt

Une page statique servie par nginx, construite sur la machine cible depuis le
code du dépôt. Elle sert à voir le suivi d'un dépôt de bout en bout.

Dans Pupitre : **Applications → Nouvelle application → Depuis un dépôt GitHub**,
puis ce dépôt et sa branche. Le fichier `examples/bonjour/pupitre.json` est
trouvé tout seul ; seuls les changements sous `examples/bonjour/` concernent
l'application, le reste du dépôt ne la touche pas.

À chaque nouveau commit, au choix :

- **mettre à jour l'application** : la nouvelle version attend que vous la
  déployiez, où vous voulez ;
- **la redéployer là où elle tourne**.

L'état est renvoyé sur le commit dans GitHub.

L'image tourne avec le durcissement que Pupitre applique à tout ce qu'il
construit depuis votre code — racine en lecture seule, utilisateur non
privilégié, sans capacité — d'où la base `nginx-unprivileged` sur le port 8080.
