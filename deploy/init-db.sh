#!/bin/sh
set -eu

for migration in schema phase2 phase3 guard-checkpoints team-identity \
  team-identity-enforcement guard-deliveries delivery-reliability
do
  psql -X --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --file "/schema/$migration.sql"
done

psql -X --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set "app_password=$BETTERGIT_DB_PASSWORD" <<'SQL'
CREATE ROLE bettergit LOGIN PASSWORD :'app_password';
GRANT USAGE ON SCHEMA public TO bettergit;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bettergit;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO bettergit;
SQL
