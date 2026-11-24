// Shell shared by the Supervisor page and by deploys that start an app:
// where Supervisor keeps its files, and how to start it with or without systemd.
export const SUP_SHELL = `if [ -d /etc/supervisor/conf.d ]; then DIR=/etc/supervisor/conf.d; EXT=conf
elif [ -d /etc/supervisord.d ]; then DIR=/etc/supervisord.d; EXT=ini
else DIR=""; EXT=conf
fi
sup_unit() { for u in supervisor supervisord; do if systemctl cat "$u.service" >/dev/null 2>&1; then echo "$u"; return; fi; done; echo supervisor; }
sup_running() { supervisorctl pid >/dev/null 2>&1; }
sup_start() {
  sup_running && return 0
  if [ -d /run/systemd/system ]; then systemctl enable --now "$(sup_unit)" >/dev/null 2>&1 || true
  else service supervisor start >/dev/null 2>&1 || service supervisord start >/dev/null 2>&1 || supervisord -c /etc/supervisor/supervisord.conf >/dev/null 2>&1 || supervisord -c /etc/supervisord.conf >/dev/null 2>&1 || true
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do sup_running && return 0; sleep 0.5; done
  return 1
}`
