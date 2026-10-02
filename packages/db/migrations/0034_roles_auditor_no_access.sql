-- Deux rôles de départ ajoutés après coup, et l'observateur resserré.
--
-- Sur une base vierge, rien de ce qui suit ne s'applique : `roles` est vide au
-- moment des migrations, et c'est le seed qui pose ensuite les rôles de départ.
-- Il reconnaît une installation neuve à une table `roles` vide — y écrire ici
-- la lui ferait prendre pour une base existante.
--
-- Sur une base existante, les rôles sont des données qu'un administrateur a pu
-- modifier, et rien de ce qu'il a fait n'est réécrit :
--   - `auditor` et `no-access` ne sont créés que si leur clé est libre ;
--   - `viewer` n'est resserré que s'il porte encore exactement sa définition
--     d'origine — toutes les permissions en `:read`, et rien d'autre.

-- 1. L'auditeur : toutes les lectures, ce que l'observateur portait jusqu'ici.
WITH created AS (
  INSERT INTO "roles" ("key", "label", "description")
  SELECT 'auditor', 'Auditeur', 'Lecture seule sur toute la plateforme, journal d''activité et comptes compris'
  WHERE EXISTS (SELECT 1 FROM "roles")
  ON CONFLICT ("key") DO NOTHING
  RETURNING "id"
)
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT created."id", p."id" FROM created, "permissions" p WHERE p."action" = 'read';
--> statement-breakpoint

-- 2. Sans accès : le rôle d'une inscription publique, sans aucune permission.
INSERT INTO "roles" ("key", "label", "description")
SELECT 'no-access', 'Sans accès', 'Aucune permission : le rôle d''une inscription, en attendant qu''un administrateur en choisisse un'
WHERE EXISTS (SELECT 1 FROM "roles")
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- 3. L'observateur, s'il est intact : sa description d'abord (seulement si elle
--    n'a pas été réécrite), puis ses lectures d'administration.
UPDATE "roles" r
SET "description" = 'Lecture seule de l''exploitation : cibles, applications, déploiements, supervision',
    "updated_at" = now()
WHERE r."key" = 'viewer'
  AND r."description" = 'Lecture seule sur toute la plateforme'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp JOIN "permissions" p ON p."id" = rp."permission_id"
    WHERE rp."role_id" = r."id" AND p."action" <> 'read'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "permissions" p
    WHERE p."action" = 'read'
      AND NOT EXISTS (
        SELECT 1 FROM "role_permissions" rp WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
      )
  );
--> statement-breakpoint
DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND r."key" = 'viewer'
  AND p."key" IN ('user:read', 'role:read', 'audit:read', 'settings:read')
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" rp2 JOIN "permissions" p2 ON p2."id" = rp2."permission_id"
    WHERE rp2."role_id" = r."id" AND p2."action" <> 'read'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "permissions" p3
    WHERE p3."action" = 'read'
      AND NOT EXISTS (
        SELECT 1 FROM "role_permissions" rp3 WHERE rp3."role_id" = r."id" AND rp3."permission_id" = p3."id"
      )
  );
