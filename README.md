# SuperDevops

DevOps manager for a team. Two parts:

- **The service** (`src/server`, one Node.js file when built) runs on a server of yours. It handles sign-in (password + Google Authenticator), accounts and roles, keeps the shared list of servers, sites and deploy history (SSH credentials encrypted on disk), writes the audit log, and is **the only thing that connects to the managed servers**. Each signed-in person gets an engine process of their own on the service (`src/server/worker.ts` running `src/main/engine.ts`), which holds that person's SSH connections, terminals and database connections, and ends at sign-out.
- **The desktop app** (Electron + React) is what people use. It shows the work and sends every action to the service; files to upload or download travel through the service in pieces (`xfer:*`). It never receives a server password or key.

What this design means: roles, server access and the audit log are enforced by the service for everyone, and nobody can take a server's sign-in home. The managed servers only need to accept SSH from the service's address, so SSH can be closed to everyone else. In exchange, the service machine holds every server's sign-in: run it on a machine you protect well (HTTPS, the address allow-list under Team, Protection, and a firewall), and keep `data/master.key` off backups that others can read. Calls that take a file never accept a path from the app, only a transfer the same session started, so nobody can make the service read or write its own files.

## Run it

Needs Node.js 20 or newer.

```bash
npm install

# 1. the service (for a first look, on your own computer)
npm run server:dev -- create-admin yourname     # prints a temporary password
npm run server:dev                              # listens on http://127.0.0.1:8787, data in ./data

# 2. the desktop app, in another terminal
npm run dev                                     # service address: 127.0.0.1:8787
```

At first sign-in you scan a QR code with Google Authenticator and choose your own password.

For a real installation on a server with HTTPS, see `deploy/README.md`.

Other scripts: `npm run build` (app), `npm run server:build` (writes `dist-server/server.js`), `npm run typecheck`.

## Accounts, roles and the audit log

| Role | Can do |
| --- | --- |
| Admin | Everything, including adding servers and their SSH keys, managing accounts, reading the audit log and terminal recordings. |
| Developer | Sites: create, deploy, roll back, maintenance mode, HTTPS. PM2 apps and cron tasks. Create databases and back them up. No terminal, firewall or server settings. |
| IT Support | Server operations: firewall, PHP, Redis, backups, alerts, HTTPS, installs, database backup / restore / delete, PM2 and cron, and the terminal. Cannot deploy code. |
| Viewer | Read only. |

Each non-admin account can also be limited to chosen servers. Sign-in always needs a password and a Google Authenticator code; 5 wrong attempts lock the account for 15 minutes. Every sign-in, refused attempt and change is written to an audit log (who, when, from where, which server, what, result); terminal sessions are recorded; the log is hash-chained so edits or deletions can be detected ("Check it has not been altered" on the Audit page).

## What works now (phase 1)

| Area | What it does |
| --- | --- |
| Projects | Servers (host, port, user, password or SSH key), added by admins. Test before saving. Credentials are stored AES-256-GCM encrypted on the service and never sent to the app; only the engine of a person allowed to use that server opens them. The server's host key is remembered on first connect and a changed key is refused. |
| Overview | Load, CPU, memory, disk rings, CPU / memory / network history, disks, top processes, system info. Refreshes every 3 seconds. |
| Sites & Deploy | Create a site: PHP, static / SPA, or reverse proxy (Node, Python, Go). Pick a framework for the URL rewrite: Laravel, ThinkPHP, WordPress, CodeIgniter 4, Yii2, Symfony, SPA. Deploy from git or by uploading a folder / .zip / .tar.gz. Writes the nginx config, tests it with `nginx -t`, rolls back if nginx rejects it, then reloads. Optional commands after deploy. |
| Safe deploys | After every deploy the app asks the site for a page. If the new version answers with a server error (or not at all) and the site was fine before, the previous version is put back automatically. Every deploy is kept in a history (commit, result, HTTP status) with rollback to any earlier one. Git sites roll back by commit; upload sites keep the last 5 copies of the previous files on the server. Telegram is told when a deploy fails or is rolled back (if alerts are set up). |
| Load balancer | A site type that spreads requests over several backend servers (round robin, least connections, or sticky by client IP), with weights, backup servers, automatic skipping of failed servers, and a "Check backends" test. |
| Server copy | Copy a folder from one saved server to another, or copy a whole site (definition, files, nginx config). Data flows through the service, so the servers need no SSH access to each other. Databases are not copied. |
| HTTPS | Per site: free Let's Encrypt certificate (certbot, installed on demand), optional redirect of HTTP to HTTPS, automatic renewal. Works for every site type. If the request fails the site stays on HTTP. No wildcard certificates. |
| PHP | Panel-style PHP management (Debian / Ubuntu): install several versions side by side (7.4 to 8.4), start / restart PHP-FPM, common php.ini settings as a form, a full php.ini editor that refuses a broken file and rolls back, and extensions: search about 85, install, enable, disable, remove. Each site picks its PHP version. |
| Redis | Install, start / stop / restart; live stats (memory, keys, clients, hit rate); settings form (listen address, port, password, memory limit and eviction policy, RDB / AOF); redis.conf editor with rollback; empty one or all databases. Refuses to open Redis to the network without a password, and converts data safely when AOF is switched. |
| PM2 apps | Per Linux user: list apps with status, CPU, memory, uptime and restarts (refreshes every 5 s); start, stop, restart, reload, remove; logs; start a new app from a script or an npm command; start on boot; install Node.js + PM2. |
| Cron jobs | Panel-style scheduled tasks: run a shell script or visit a URL every N minutes / hour / day / week / month or by cron expression; enable or disable, run now, per-task log and last result. Warns when the cron service is not running. |
| Maintenance mode | Per site: visitors get a 503 "We will be back soon" page; one IP of your choice still sees the real site. |
| Firewall | System firewall (ufw; firewalld on RHEL-family): on/off, allow/deny rules by port and source IP. SSH is always opened before switching on, and a rule that would block SSH for everyone is refused. Nginx firewall: IP blocklist and per-visitor rate limit for every site. |
| Logs & Alerts | Log viewer (auth, system, nginx, journal) with filter and live mode. Attack summary: top sources of failed SSH logins and busiest web visitors, with one-click block. Telegram alerts sent by the server itself every 2 minutes: disk, memory, CPU load, SSH attack, nginx down. |
| Databases | MySQL / MariaDB: create a database with its own user, delete, back up now, restore (also into a new database), download a dump, daily backups with retention. |
| Backups | Back up any folder to a git repository, manually or on an hourly / daily schedule, with history and restore. Shows the server's SSH public key to add as a deploy key. |
| Server environment | Shows nginx, PHP, git, unzip. One-click install through apt, dnf or yum. |
| Git accounts | Save an access token once (Sites, New site, Git accounts). A site that uses the account deploys a private https:// repository without anyone typing a token; the token is handed to git for that run only and is not stored on the managed server. An account is private to its owner or shared with the whole team. |
| Sharing | Each server is "Only me", "Whole team" or "Chosen people", set by the person who added it. A private server is hidden from everyone else, admins included. Admin, Developer and IT Support can add servers; Viewers cannot. |
| Lock | On a Mac with Touch ID: lock from the account menu or Cmd+Shift+L, and after 15 idle minutes; unlock with a fingerprint. A locked app signs out after 45 minutes. Without Touch ID, idle time signs out. Closing the window asks first while signed in. |
| Security check | Score out of 100 from eight checks (firewall, root password sign-in, password guessing, automatic updates, waiting updates, open database ports, pending restart, extra root accounts) with one-click fixes where that is safe (Debian / Ubuntu). |
| Auto deploy | Per git site: the server checks the branch every 2 minutes, deploys a new commit, checks the site still answers and puts the previous version back if not. With a Git account, its token is stored on that server (root only) while auto deploy is on. |
| Backup copies | Databases page: send every database backup to another of your servers, hourly, through a locked-down account, and keep them there for N days. |
| Database Remote | Its own menu entry. Right-click a connection, database or table for: new database, new table and design table (a grid of columns with an SQL preview), duplicate, rename, empty, drop, export as an SQL file, run an SQL file. Several query tabs, and queries saved by name on this computer. Works like a desktop database tool: **New connection** has a General tab (host, port, user name, password) and an SSH tab (tunnel through an SSH server with a password or private key, or through one of the saved servers), with a Test connection button. Connections are saved (private or shared with the team), and the server you are managing is always listed as a ready-made connection. For MySQL / MariaDB: pick a database and table, page through rows, filter with a WHERE condition, sort, edit a value by double-clicking, add and delete rows (tables with a primary key), see the structure, run SQL with several result sets, export CSV. Runs over the SSH connection as the database's root, so port 3306 stays closed. |
| Connect GitHub | In the site form: press Connect GitHub, approve once in the browser with a short code, then pick the repository and the branch or tag from lists. Private repositories included. The first time, an admin registers a free GitHub OAuth App (with Device Flow enabled) and pastes its Client ID; the form shows the steps. |
| Restart | Overview, top right. Restart one service (nginx, PHP-FPM, MySQL / MariaDB, Redis, cron...; nginx's configuration is checked first) or the whole server, with a wait until it answers again. Restarting the server is for Admin and IT Support. |
| PHP: Optimize | PHP page, Settings tab. Pick the server's memory and CPU (detected for you) and what else runs on it; the app shows every php.ini and PHP-FPM worker setting it would change and why, then applies them. Limits already set higher are never lowered. |
| PHP: Disabled functions | Its own tab: disable a function for websites, enable it again, or disable the ones that run programs in one click. |
| Blocked addresses | Settings, Fail2ban row: see which addresses are blocked, unblock one, block one by hand. |
| Database passwords | The password of a database user created here is kept encrypted on the service. Databases page, "Show password": shown again after a fresh code from Google Authenticator; every look is in the audit log. |
| Restore | Restoring a database backup asks for a fresh authenticator code first. |
| Google Drive backups | Databases and Backups pages, "Copies on Google Drive". Sign in to Google once with a code; every hour the server uploads new database backups and a daily archive of the folders you choose to a folder in your Drive, and removes copies older than the days you set. Needs a Google OAuth client of type "TVs and Limited Input devices" (the dialog lists the steps). |
| Tasks | Top bar. Every running or finished task with its log, so a log you closed can be opened again. |
| Dashboard | Every server you can use on one screen: CPU, memory, fullest disk, uptime, number of sites, soonest certificate expiry, and what needs attention. Opening it connects to each server. |
| History | "Keep history" on the Overview page makes the server record its own load once a minute (kept 7 days), so charts cover the last hour, 24 hours or 7 days even when the app was closed. |
| Files | File manager like a hosting panel: browse, create files and folders, edit text files (up to 2 MB, with a warning when someone else changed the file meanwhile), rename, copy, cut and paste, upload files or a whole folder, download (folders as .tar.gz), compress and unpack (.tar.gz, .zip), permissions and owner, folder size. Runs as root, so it reaches every file. Admin and IT Support work on the whole server; Developers only inside `/www/wwwroot`. System folders cannot be deleted or moved. Deleted items go to a trash on the server (`/var/lib/superdevops/trash`) and can be restored. Code files open in an editor with syntax colours, line numbers, search and Ctrl/Cmd+S. |
| App Store | PHP, PM2, Redis and Server copy are opened from here; MySQL has a shortcut. Security check, Firewall and Logs & Alerts share the Settings menu. |
| Terminal | Tabbed SSH terminal (xterm.js). Sessions stay open while you use other pages. |
| UI | Light and dark theme. |

## Things to know

- Deploys need administrator rights. Log in as root, or as a user with sudo. For a sudo user with key login, fill in "sudo password" on the project.
- A git deploy makes the server folder match the branch exactly. Files changed by hand on the server inside that folder are overwritten.
- Private repositories: add the server's SSH public key as a deploy key, or use an HTTPS URL that contains a token.
- Site configs are written to `/etc/nginx/conf.d/superdevops-<name>.conf` (or the aaPanel vhost folder when that is what the server has). Turn on HTTPS per site from its "More" menu.
- Removing a site never deletes its files on the server.
- Everything the service knows lives in its data folder: `users.json`, `superdevops.json` (servers, sites, deploy history), `audit.log`, `terminal/` recordings and `master.key`. Back it up; without `master.key` the stored credentials cannot be decrypted.

## Layout

```
src/shared/types.ts      types used by all three layers
src/server/main.ts       the service: HTTP + WebSocket, encryption, command line
src/server/rpc.ts        sign-in, accounts, shared servers and sites, audit reports, terminal recordings
src/main/engine.ts       every server operation with its permission; SSH connections; terminals
src/server/auth.ts       accounts, passwords, Google Authenticator codes, lockout, sessions
src/server/audit.ts      hash-chained audit log
src/shared/team.ts       roles and permissions
src/main/index.ts        desktop shell: connection to the service, runs the engine, dialogs
src/main/files.ts        file manager
src/main/ssh.ts          connect / exec / sftp helpers (ssh2)
src/main/monitor.ts      system stats sampler
src/main/deploy.ts       site validation, nginx config, deploy scripts
src/main/transfer.ts     server-to-server folder copy
src/main/firewall.ts     ufw / firewalld and the nginx firewall
src/main/logs.ts         log viewer, attack summary, Telegram alerts
src/main/database.ts     MySQL / MariaDB management and dumps
src/main/backup.ts       folder backups to git
src/main/php.ts          PHP versions, php.ini and extensions
src/main/pm2.ts          PM2 process manager
src/main/cron.ts         scheduled tasks
src/main/ssl.ts          HTTPS certificates (certbot)
src/main/redis.ts        Redis management
src/main/store.ts        saved servers, sites and deploy history (file on the service, memory copy in the app)
src/preload/index.ts     the `window.api` bridge
src/renderer/src/        React UI (antd)
```

## Images

- `build/icon.png` (1024, for installers), `resources/icon.png` (window and Dock icon), `src/renderer/src/assets/icon.png` (sidebar)
- `src/renderer/src/assets/banner.jpg` (Projects page header)
- `src/renderer/src/assets/welcome.png` (empty Projects page; flattened on white because the source had no real transparency)

## What the app leaves on a server

Everything it writes is named `superdevops`, so it is easy to find and remove:

- `/etc/nginx/conf.d/superdevops-*.conf` (sites, `00-firewall`)
- `/etc/superdevops/` (alert settings incl. the Telegram token, mode 600; backup jobs)
- `/etc/cron.d/superdevops-*` (alerts, database backups, folder backups, certificate renewal, your cron tasks)
- `/etc/letsencrypt/live/superdevops-<site>/` (certificates, managed by certbot)
- `/usr/local/bin/superdevops-*.sh`
- `/var/lib/superdevops/`, `/var/backups/superdevops/` (database dumps, and `sites/<name>/` rollback copies for upload sites), `/var/log/superdevops-backup-*.log`

## Not built yet

SSH hardening / Fail2ban, wildcard certificates, start / stop services, PM2 cluster mode and env vars, Node / Python version management, PHP-FPM pool tuning, zero-downtime releases, auto deploy on push, .env editor, Docker, PostgreSQL, database copy between servers, long-term monitor history, installers, Khmer / Chinese interface, single sign-on, per-site permissions, an IP allow-list inside the service (use nginx for now). The in-app Roadmap page lists the same.

## Tested and not tested

Tested end to end on Ubuntu 24.04 with real sshd, nginx, PHP-FPM, ufw and MariaDB (about 250 automated checks, 42 of them on sign-in, roles and the audit log), and the app window was driven through every page on Linux.

Not tested: macOS and Windows builds of the app, firewalld (code path exists, never run), dnf / yum installs, aaPanel-style nginx layouts, sending to the real Telegram API (tested against a stand-in endpoint), requesting a real Let's Encrypt certificate (tested with a stand-in for certbot that checks the verification URL and issues a self-signed certificate; nginx TLS itself is real), PM2 start-on-boot (needs systemd, which the test machine lacks), and cron firing the alert / backup schedules (a cron task was confirmed to fire for real; the alert and backup scripts were executed directly).

## Development sign-in

`npm run server:dev` starts the service with `--dev-no-2fa`: sign-in asks for the password only. This works only while the service listens on 127.0.0.1; on any other address the flag is ignored and authenticator codes are required. `npm run server:dev:2fa` runs the same service with codes, and `npm run server:start` (the built service you deploy) always requires them unless you pass the flag yourself.

## Installers and the download website

- `npm run dist:mac`, `npm run dist:win`, `npm run dist:linux` build an installer on the system it is for. See `RELEASING.md`.
- `.github/workflows/release.yml` builds all of them on GitHub when a tag such as `v1.0.0` is pushed.
- `website/` is the download site: plain files, with `website/config.js` holding the version and the download address.
