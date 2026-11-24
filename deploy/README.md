# Installing the SuperDevops service

The service is one file, `server.js`. It needs Node.js 20 or newer and nothing else.
Everyone's desktop app signs in to it. It stores your servers' SSH passwords and keys
(encrypted) and is the only thing that connects to the managed servers: each signed-in
person's work runs in a process of its own here, and the apps never receive a password
or key. So treat this machine as your most sensitive server, and make sure it can reach
your servers' SSH ports. Those servers then only need to accept SSH from this machine's
address, and you can close SSH to everyone else.

Files people upload or download pass through `data/tmp/xfer` on their way and are removed
when the transfer ends. Leave room on the disk for the largest upload you expect (up to 4 GB).

## 1. Put it on the server (Ubuntu / Debian)

```bash
# on your computer, in the project folder
npm install
npm run server:build                       # writes dist-server/server.js
scp dist-server/server.js deploy/superdevops.service deploy/nginx.conf.example root@YOUR_SERVER:/root/

# on the server
apt-get install -y nodejs nginx certbot python3-certbot-nginx     # Node 20+ (use NodeSource if your distro's is older)
useradd --system --home /opt/superdevops --shell /usr/sbin/nologin superdevops
mkdir -p /opt/superdevops /var/lib/superdevops-service
mv /root/server.js /opt/superdevops/
chown -R superdevops: /opt/superdevops /var/lib/superdevops-service
chmod 700 /var/lib/superdevops-service
mv /root/superdevops.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now superdevops
```

## 2. HTTPS in front of it

Every action, every terminal keystroke and every file passes over this connection, so give
the service a domain name and a certificate. (The app also accepts plain HTTP, but then
all of that travels unencrypted.)

```bash
mv /root/nginx.conf.example /etc/nginx/conf.d/superdevops-service.conf
# edit the file: put your domain in server_name, and ideally your office IPs in allow / deny
nginx -t && systemctl reload nginx
certbot --nginx -d devops.example.com
```

## 3. Create the first admin

The running service keeps the accounts in memory, so stop it for the console commands
(here and under "Looking after it"), or it will not see the change and may write over it.

```bash
systemctl stop superdevops
cd /opt/superdevops
sudo -u superdevops SUPERDEVOPS_DATA=/var/lib/superdevops-service node server.js create-admin yourname "Your Name"
systemctl start superdevops
```

It prints a temporary password. In the desktop app enter the service address
(`devops.example.com`), that username and password, scan the QR code with Google
Authenticator, and choose your own password. Add colleagues from the **Team** page.

## Looking after it

- **Back up `/var/lib/superdevops-service`.** It holds the accounts, the servers' encrypted
  credentials, the audit log, terminal recordings, and `master.key`. Without `master.key`
  the stored credentials cannot be decrypted. Keep the backup somewhere as protected as the
  server itself.
- **Updating:** build a new `server.js`, replace the file, `systemctl restart superdevops`.
  A restart signs everyone out; they sign in again.
- **Locked out?** On the server, with the service stopped, as above with `sudo -u superdevops ... node server.js`:
  - `reset-password <username>` gives a new temporary password
  - `reset-2fa <username>` makes them set up the authenticator again
  - `verify-audit` checks that nobody altered the audit log
  These commands are themselves written to the audit log.
- **Who can reach it:** use the `allow` / `deny` lines in the nginx file, or a firewall, so
  only your office or VPN can connect.

## What is enforced

- Password (6+ characters) and a Google Authenticator code at every sign-in. No exceptions, no "remember me".
- 5 wrong attempts lock an account for 15 minutes. An admin can unlock it.
- Sessions end after 60 minutes without requests, after 12 hours at most, and the app signs out after 15 minutes without mouse or keyboard use.
- Roles: Admin, Developer, IT Support, Viewer (the Team page lists what each can do), and each person can be limited to chosen servers.
- Every sign-in, refused attempt and change is in the audit log with who, when, from which address, on which server. Terminal sessions are recorded. Entries are chained, so edits and deletions are detectable.
