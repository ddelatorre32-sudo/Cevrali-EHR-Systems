# Host Cevrali as a website

For the restricted synthetic staff pilot, use [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md), [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md), and [AUDIT-INTEGRITY.md](AUDIT-INTEGRITY.md). The hosting recipes below explicitly run demo mode. This release refuses clinical production startup; publishing it does not authorize real patient use.

Cevrali already has a browser frontend and an application server. The Docker deployment serves both from one service, with persistent storage for the demo database and organization accounts. Hosting that service gives users a normal website address. A custom domain is optional.

This deployment is for the existing synthetic demo. Public demo accounts and demo external connections remain enabled; use synthetic information only. Hosting this demo does not establish readiness for real clinical use.

## What is prepared

- `Dockerfile` builds the React frontend and Node 24 server, includes the local OCR utilities and RFA assets, and runs the application process as the unprivileged `node` user.
- `render.yaml` describes one Render Docker web service with an attached persistent disk, an API health check, and secure session cookies for HTTPS.
- `compose.yaml` provides a local container check using the same persistent directory.
- The image build excludes working databases, environment files, generated previews, dependencies, and Git metadata. A new hosted disk starts with fresh synthetic demo records; local practice data is not included.

No website has been published by creating these files. Publishing a cloud development-environment snapshot also does not publish a website or retain live server processes. The chat's HTML source viewer does not run the application.

## Choose the application branch

Use the **`cevrali-hosted-demo`** branch for this prepared deployment. The original `main` branch contained only `README.md`; selecting that original revision cannot build the application. Confirm that the selected branch on GitHub contains the complete application and deployment files before connecting Render.

Review and publish the application source, including `Dockerfile`, `.dockerignore`, `deploy/`, `render.yaml`, `package.json`, `package-lock.json`, `src/`, `server/`, `scripts/`, `tests/`, `index.html`, `.nvmrc`, and the TypeScript/Vite configuration files. Keep `.data/`, `.env` files, generated previews, credentials, and local backups out of Git. Verify the selected branch on GitHub contains the deployment files before continuing.

The Render configuration explicitly selects `cevrali-hosted-demo`. If you later release from another branch, update its `branch` setting as well. Hosting-account creation and any plan purchase remain actions in your own hosting dashboard.

## Deploy the demo on Render

1. Create a hosting account at [Render](https://render.com/) and connect the GitHub repository through Render's account interface. No hosting password or API key needs to be placed in chat or the repository.
2. Choose **New → Blueprint**, select the repository and **`cevrali-hosted-demo`** branch, and use the root `render.yaml` file.
3. Review the proposed web service and persistent disk, including Render's current plan and storage pricing, before applying the Blueprint. This configuration uses the Starter service plan and a 1 GB disk; it does not assume free persistent storage.
4. Let Render build the Docker image and start the service. The readiness path is `/api/health`; a successful response includes `"status":"ok"`.
5. Open the HTTPS website URL issued in the Render service dashboard. No custom domain is needed for this first version. Use the URL supplied by Render rather than inventing an address from the service name.
6. Open the clinician or front desk demo, register a synthetic patient, and confirm chart editing and scheduling work. Restart the hosted service and confirm the test record remains available.

Automatic deployments are disabled in this configuration. After reviewing a source update, trigger the next deployment from the hosting dashboard. A persistent disk must stay attached when deploying or restarting.

Render supplies the public HTTPS endpoint. The application listens on `0.0.0.0` and honors the host's `PORT` environment variable. `COOKIE_SECURE=true` makes session cookies usable over HTTPS. No Vite development server, public database port, or external healthcare credentials are required.

## Persistent data

Mount the service's persistent disk at **`/var/lib/cevrali`** and retain the complete directory:

| Setting | Hosted value | Contents |
| --- | --- | --- |
| `DATABASE_PATH` | `/var/lib/cevrali/cevrali.sqlite` | Synthetic demo workspace, sessions, and workflow state |
| `ACCOUNTS_PATH` | `/var/lib/cevrali/accounts` | Organization registry, per-practice databases, sessions, and workflow state |

Keep SQLite WAL and related files together with their databases. Run one application instance against this disk; this configuration does not support independent replicas sharing SQLite files. The entrypoint prepares the mounted directory and then drops privileges before starting Node. Keep custom database/account paths under this mounted directory.

Back up the complete persistent directory using a consistent disk snapshot or a controlled maintenance shutdown. Stop writes and close the application before copying database files; copying only a live `.sqlite` file can omit committed WAL data. Store backups outside the Git repository and image build context. Test restoration on a separate disk before relying on a backup. Increasing or removing the service does not replace a backup process.

## Local container validation

The prepared image was built and exercised locally: it served HTML and JavaScript, created an isolated practice and patient, saved a reviewed allergy record, and retained the registry, sessions, patient, and history after container recreation. Runtime port overrides, secure-cookie settings, non-root application execution, and local OCR tools were checked. Public hosting and the provider's HTTPS endpoint remain separate deployment steps.

Builders behind an existing trusted TLS proxy can pass its public CA certificate as the optional BuildKit secret `cevrali_build_ca`. The secret is used only by dependency installation/build steps and is not included in the final image. For example, when `NODE_EXTRA_CA_CERTS` already points to your trusted CA file:

```bash
docker build --secret id=cevrali_build_ca,src="$NODE_EXTRA_CA_CERTS" -t cevrali-ehr:demo-ready .
```

Normal public hosting does not require this optional build secret. Keep npm TLS verification enabled.

From a machine with Docker and Docker Compose installed, run these commands in the checkout:

```bash
docker compose build
docker compose up -d
docker compose logs --tail=100 web
curl --fail http://127.0.0.1:8080/api/health
```

The loopback address above is an internal validation target, not a public website URL. The Compose file binds that port to the local machine and uses `COOKIE_SECURE=false` for local HTTP testing. The hosted Render configuration uses HTTPS and secure cookies.

To stop the local service while retaining its data:

```bash
docker compose down
```

Do not use `docker compose down --volumes` when data should be retained. Rebuilding the image should retain records in the named volume. For another Docker hosting provider, use the same image, a single instance, persistent storage at `/var/lib/cevrali`, an HTTPS endpoint, and `COOKIE_SECURE=true`.
