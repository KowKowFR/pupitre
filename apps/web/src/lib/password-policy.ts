/**
 * The password policy — a single value, shared by the server
 * (`emailAndPassword.minPasswordLength`), the account routes and the forms. It
 * takes as is what sign-up already required: a password change is not the place
 * to harden the rule unilaterally, otherwise an account becomes harder to secure
 * than to create.
 *
 * This module is not `server-only`: the client forms import it to refuse a
 * password that is too short without a network round trip.
 */
export const PASSWORD_MIN_LENGTH = 12;
