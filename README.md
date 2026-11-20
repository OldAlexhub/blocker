# Nexus Internet Scheduler

Pick a device, choose the days and hours it should lose internet, and the app blocks and restores it automatically. It uses the NETGEAR C6230's own **Access Control** feature (per-device Allow/Block by MAC) through the router's local SOAP service. No cloud, no ARP tricks, and no changes to WAN, DNS, DHCP or Wi-Fi settings.

Stack: Node.js 22+, Express 5, EJS, Bootstrap 5 (served locally), PostgreSQL (`pg`), node-cron and pino. There are 7 runtime dependencies.

---

## 1. What has and hasn't been verified

| Item | Status |
|---|---|
| Router is a C6230, firmware V1.00.17, SOAPVersion 3.54, LoginMethod 2.0 | **Verified** (`/currentsetting.htm`) |
| SOAP service answers on `http://192.168.0.1:5000/soap/server_sa/` (needs login) | **Verified** |
| Access Control (Allow/Block by MAC) exists in the C6230 UI | **Verified**: official manual p.28 |
| Router's Attached Devices list shows Allowed/Blocked per device | **Verified**: official manual p.81 |
| SOAP actions `SOAPLogin`, `GetAttachDevice2`, `SetBlockDeviceByMAC`, `GetBlockDeviceEnableStatus` | **Taken from pynetgear; not yet confirmed on your router.** Run `npm run router-check`. |
| A blocked device keeps Wi-Fi but loses internet | **Expected; test on your router** |
| Blocks survive a router reboot | **Unknown.** The app re-applies them anyway (see §6) |
| Router health: `GetSystemInfo` (CPU/memory), `GetTrafficMeterStatistics` (total traffic) | **Verified** on V1.00.17 (2026-11-19) |
| Traffic **per device** (`AdvancedQoS:1#GetCurrentDeviceBandwidth` and similar) | **Not supported**: the router answers 501 |
| Restart router (`DeviceConfig#Reboot`) | **Not verified** (testing it would restart the router). A 501 answer is shown as "use the power button" |

---

## 2. Install

1. **Install packages**

   ```powershell
   npm ci            # or: npm install
   ```

2. **Create the database.** This adds a dedicated role and database and doesn't touch any other database.
   - Edit the password in [scripts/db-setup.sql](scripts/db-setup.sql), then run:

     ```powershell
     & "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -f scripts\db-setup.sql
     ```

3. **Configure**

   ```powershell
   copy .env.example .env
   notepad .env
   ```

   Set these:
   - `DATABASE_URL`
   - `ROUTER_PASSWORD`
   - `SESSION_SECRET`: generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
   - `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`: your dashboard login (password at least 10 characters). Put the password in quotes if it contains `#` or spaces, for example `DASHBOARD_PASSWORD="my #pass word"`.

   On every start, the app writes the dashboard login to PostgreSQL as a scrypt hash. To change the password, edit `.env` and restart.

   Leave `DRY_RUN=true` for now.

4. **Check the router (read-only; changes nothing)**

   ```powershell
   npm run router-check
   ```

   You should see your devices with Allow/Block status, and Access Control **ON**.

5. **Run it**

   ```powershell
   npm start
   ```

   Open http://127.0.0.1:3000.

---

## 3. Safe rollout (do these in order)

1. **Read-only discovery.** With `DRY_RUN=true`, click **Refresh from router**.
   - Check that this PC (Nexus) and the router show as **Protected**.
   - Mark any other infrastructure as protected: switches, access points, a NAS, your own phone.
2. **Dry run.** Create a schedule for one device that starts in a couple of minutes.
   - The Activity table should show `Would block … No command sent`, then `Would restore`.
3. **Router setting.** In the router UI, open ADVANCED > Security > Access Control and confirm:
   - **Turn on Access Control** is checked;
   - **Allow all new devices to connect** is selected. Never choose "Block all new devices".
4. **Arm**
   - Set `DRY_RUN=false` in `.env` and restart the app.
   - Click **Arm router control…** and type `ARM`. The app refuses to arm if the router reports Access Control is off.
5. **One test device.** Pick a spare phone you can check by hand.
   - Click **Block** (15 min). Confirm the Activity row says **verified** and that the phone really has no internet.
   - Click **Restore**. Confirm it's verified and the phone works again.
6. **Restart tests**
   - Restart the app during a block window; the device should stay blocked.
   - Reboot the router; within one poll interval the app re-applies any block the router lost.
7. **Then** add your real schedules.

---

## 4. Rules: how the app decides

Each device is checked every minute, from highest priority down:

1. **Protected devices are never blocked.** These are this server, the router, `PROTECTED_MACS`, and anything you mark protected. This is enforced in three places: the API, the reconciler and the router adapter. If the app had blocked a device that later becomes protected, the app restores it.
2. **A manual override wins** until it expires. Every override has an expiry: 15 min to 24 h, or "until next schedule change". There's one override per device, and a new one replaces the old.
3. **Unmanaged devices** (Managed switch off) are left alone. The only exception: if the app blocked one earlier, it restores it. Blocks you set yourself in the router UI on unmanaged devices are never touched.
4. **Managed devices** are blocked while **any** enabled schedule covering them is active, and allowed otherwise.
   - Overlapping schedules: the device stays blocked until **none** apply.
   - Disabling one schedule doesn't restore a device while another still applies.
   - A managed device is fully controlled by the app. If you block it in the router UI while no schedule applies, the app will restore it.
5. **Overnight windows** (for example Sun–Thu 21:00 → 07:00) belong to the day they **start**. Thursday 21:00 → Friday 07:00 is blocked; Friday night isn't.
6. **Time and DST.** All times are wall-clock times in `APP_TIMEZONE`. On the DST change days, a window covering the skipped hour starts at 03:00, and a 07:00 restore always happens at 07:00 local time.

## 5. What the statuses mean

| Shown | Meaning |
|---|---|
| **verified** | Command sent **and** a fresh read of the router's device list shows the expected Allow/Block. |
| **unverified** | Command accepted, but the router doesn't list the device (offline), so it can't be confirmed. Not repeated while the device stays offline. |
| **failed** | The command errored, or the router still reports the old state. Retried with backoff: 1, 2, 4 … 30 min. |
| **requested** | Command was being sent when the app stopped. |
| **dry run** | Simulated only. Nothing was sent. |
| Internet column: **Blocked (router-confirmed)** | That's what the router itself last reported. **Offline** is not the same as blocked. |

"Verified" means the router confirms it stored the block. Whether the device actually lost internet depends on router firmware, which is why step 5 of §3 checks this by hand once.

## 6. Reliability design

- **Level-based reconciler, not one-shot cron jobs.** Each minute the app compares *should be* with *router says*, and acts only on the difference. Missed cron ticks, app crashes, Windows reboots and router reboots all correct themselves on the next pass.
- **Router access**
  - The device list is re-read every `ROUTER_POLL_MINUTES` (default 5), and before every command.
  - Router commands are strictly serialized.
  - Timeouts are 10 s, and the app logs in again automatically after a router restart.
  - Reads back off when the router is unreachable: 1 → 30 min.
- **Database**
  - A database outage during a pass is logged and retried the next minute.
  - If PostgreSQL isn't up yet at boot, the app waits for it.
- **Single instance:** a PostgreSQL advisory lock means two copies can never schedule at once.
- **Everything persists in PostgreSQL:** devices, schedules, overrides, last verified state, the activity log and sessions.

## 7. Run at boot (Windows 11)

From an **elevated** PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

This sets up:
- a Task Scheduler task that starts at boot (with a 30 s delay) and runs as SYSTEM, with no login needed;
- a supervisor ([src/supervisor.js](src/supervisor.js)) that restarts the app if it crashes, with backoff;
- logs in `logs\app.log`, rotated at 10 MB with 5 kept;
- read access to `.env` limited to SYSTEM, Administrators and you.

To remove it: `scripts\uninstall-service.ps1`. Restore blocked devices first.

> Install Node.js machine-wide (`C:\Program Files\nodejs`) so SYSTEM can run it.

### LAN access (optional, later)

1. Confirm login works on `127.0.0.1`.
2. Set `HOST=0.0.0.0` and `ALLOW_LAN=true`, then restart.
3. Allow the port only on your private network:

   ```powershell
   New-NetFirewallRule -DisplayName "Nexus Internet Scheduler" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress LocalSubnet -Action Allow
   ```

Never forward this port on the router. The dashboard runs over plain HTTP and is meant for your LAN only.

---

## 8. Manual recovery (no app needed)

**If a device is stuck blocked**, from any phone or PC on the network:

1. Go to http://192.168.0.1 and log in as `admin`.
2. Open **ADVANCED > Security > Access Control**.
3. Choose one:
   - **Restore one device:** tick it in the blocked list and click **Allow**, then **Apply**.
   - **Restore everyone at once:** clear **Turn on Access Control** and click **Apply**. The manual says all devices are allowed when this box is cleared.

Then stop the app or disarm it, so it doesn't re-apply the block:
- dashboard: **Restore all & disarm**; or
- set `DRY_RUN=true` and restart; or
- stop the boot task: `Stop-ScheduledTask "Nexus Internet Scheduler"`.

## 9. Known limitations

- **Private/random Wi-Fi addresses.** Phones that use them can show up as a "new" device and escape a schedule. These are flagged **private MAC** on the dashboard. For scheduled devices, turn off private addressing for your home Wi-Fi network on that device.
- **Undocumented interface.** The SOAP interface isn't documented by NETGEAR. Cable providers can push firmware that changes it. If that happens, `npm run router-check` will show it, and every action will log **failed**; nothing will claim false success.
- **One schedule timezone for the whole app** (`APP_TIMEZONE`).
- **No per-device traffic.** The C6230 only reports CPU, memory and total internet usage, so the dashboard's **Router health** card can show that the router is overloaded, but not which device causes it.

### Router health and restart

The dashboard's **Router health** card reads CPU, memory and total traffic from the router (read-only, cached for 15 s). A warning appears when CPU is at least 80% or memory is at least 90%. An overloaded router answers slowly and makes the whole network feel slow.

**Restart router…** asks you to type `RESTART`, then sends the router's restart command. It works whether or not router control is armed, because it doesn't change any device rule. Every device loses internet for about 3–5 minutes. The scheduler pauses polling for 4 minutes, then re-reads the router. After a restart, the button is locked for 10 minutes.

## 10. Project layout

```
src/
  server.js             entry: config check, DB, migrations, instance lock, web, cron
  supervisor.js         crash-restart wrapper used by the boot task
  config.js, logger.js
  core/engine.js        pure schedule logic (overnight, DST, overlaps, overrides)
  core/protection.js    protected MACs/IPs (this server, router, configured)
  router/               RouterAdapter interface, NETGEAR SOAP adapter, mock adapter
  services/reconciler.js  the only code that changes router state
  db/                   pool, migrations, store (all SQL), session store
  web/                  Express app, auth/CSRF, JSON API
  views/, public/       EJS pages, dashboard JS/CSS
scripts/                router-check (read-only), set-password, db-setup.sql, install/uninstall service
tests/                  node:test suites (mock router, in-memory store)
```

Run the tests with `npm test`.
