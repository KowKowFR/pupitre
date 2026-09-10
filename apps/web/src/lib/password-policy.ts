/**
 * Politique de mot de passe — une seule valeur, partagée par le serveur
 * (`emailAndPassword.minPasswordLength`), les routes de compte et les
 * formulaires. Elle reprend telle quelle ce que l'inscription exigeait déjà :
 * un changement de mot de passe n'est pas l'endroit où durcir la règle
 * unilatéralement, sinon un compte devient plus dur à sécuriser qu'à créer.
 *
 * Ce module n'est pas `server-only` : les formulaires client l'importent pour
 * refuser un mot de passe trop court sans aller-retour réseau.
 */
export const PASSWORD_MIN_LENGTH = 12;
