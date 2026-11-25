# Self-host Better Git on a Linux VM

This setup runs the control plane, PostgreSQL, and Caddy on one VM. Docker keeps the database and the control plane off host ports. Caddy exposes HTTPS and obtains and renews certificates for your domain.

## Prepare the VM and GitHub App

1. Install Docker Engine with the [Compose plugin](https://docs.docker.com/compose/install/linux/), Git, and OpenSSL. Point a DNS record at the VM. Allow inbound TCP 80 and 443 and restrict SSH to your administration network. A small VM can run the services for evaluation. If the first Rust build runs out of RAM, build the image on a larger Linux host of the same architecture and load it on the VM.
2. [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) under the GitHub organization you want to protect. Enable device flow and webhooks. Set the webhook URL to `https://YOUR_DOMAIN/webhooks/github` and generate its secret with `openssl rand -hex 32`. Use the permissions and events in the [control-plane reference](../control-plane/README.md). Keep the app private for a single organization. Record the App ID and client ID, generate a client secret and download a private key. Add the app installation to a disposable test repository once the service is up.

## Start the services

```sh
git clone https://github.com/MegaPanchamZ/bettergit.git
cd bettergit/deploy
install -m 600 .env.example .env
```

Edit `.env` with your DNS name, GitHub App settings and the webhook secret you registered with GitHub. For each of `POSTGRES_PASSWORD` and `BETTERGIT_DB_PASSWORD`, generate a distinct hex value with `openssl rand -hex 32`. Paste the full PEM into the single-quoted `GITHUB_PRIVATE_KEY` value, keeping its line breaks. The local `.env` contains secrets and is gitignored. Keep the downloaded key outside the checkout and restrict access to the VM and its Docker daemon.

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 control-plane proxy
```

On an empty database volume, Postgres applies the SQL files in order and creates a separate runtime login. Postgres data and TLS certificates persist in Docker volumes. The database connection stays on a private Docker network on this VM. For a separate database host, follow the [native setup](../control-plane/README.md) for authenticated TLS and database grants.

Open your domain over HTTPS to verify that Caddy serves the Better Git landing page. The control plane handles `/v1/*` and `/webhooks/github`. Confirm a successful signed delivery in the App's **Advanced → Recent deliveries** view. Use the [CLI enrollment steps](../README.md#managed-directory) and the [staging validation steps](../docs/validation.md#production-release-gates) to test actual login, enrollment and merge checks before relying on them.

## Back up and upgrade

Back up the database with `docker compose exec -T db pg_dump -U postgres -Fc bettergit > bettergit.dump` and store the dump and deployment credentials securely off the VM. Protect the database volume and test restoring a backup before upgrades.

Routine restarts retain your database. The initializer runs only on an empty volume. Before upgrading, review the migration instructions and apply any pending schema changes as the migration role. Grant the runtime role access to any new tables or sequences, then run `docker compose up -d --build` on the new checkout. If first-time initialization fails, inspect the database logs and correct the cause before retrying with a fresh, empty volume. Preserve volumes that contain data.
