-- A new instance now starts in English (locale `en-US`, English tagline).
--
-- An instance installed before keeps the French values it was born with: the
-- settings are read with their defaults filled in, so an instance that never
-- saved a value would otherwise switch language on upgrade. An existing
-- instance is recognized by its accounts; on an empty database (a fresh
-- install, or migrations run before the first sign-up) nothing is written,
-- and the new defaults apply.
--
-- Only absent keys are filled: `||` keeps the stored value when there is one.
INSERT INTO "app_settings" ("id", "value")
SELECT 1, '{"locale":"fr-FR","instanceTagline":"Plan de contrôle de déploiement"}'::jsonb
WHERE EXISTS (SELECT 1 FROM "users")
ON CONFLICT ("id") DO UPDATE
SET "value" = '{"locale":"fr-FR","instanceTagline":"Plan de contrôle de déploiement"}'::jsonb || "app_settings"."value";
--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "value" SET DEFAULT '{"instanceName":"Pupitre","instanceTagline":"Deployment control plane","timezone":"Europe/Paris","locale":"en-US","dateStyle":"short","timeStyle":"medium","ai":{"provider":"openrouter","model":"anthropic/claude-sonnet-4.5","baseUrl":"","enabled":true,"temperature":0.2,"maxTokens":8192},"security":{"scanningEnabled":true,"disabledScanners":[],"failOn":"NONE","onlyFixable":false},"sso":{"enabled":false,"label":"Keycloak","issuer":"","clientId":"","scopes":"openid profile email","autoCreate":true,"linkByEmail":true,"groupsClaim":"groups","roleMappings":[],"defaultRole":"no-access","syncRoles":true},"accounts":{"twoFactorPolicy":"off","sessionIdleHours":168,"sessionMaxHours":null},"onboarding":{"status":"pending","currentStep":"welcome","completed":[],"skipped":[],"offeredAt":null,"finishedAt":null,"dismissedAt":null,"runs":0}}'::jsonb;
