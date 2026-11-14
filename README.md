# luci-app-wban

A LuCI app for OpenWrt to **see who is on your Wi-Fi, kick them, and ban / unban them**. You can ban by MAC address or by **device name**, so a phone that switches to a new random MAC still gets caught.

Find it in LuCI under **Network → Wi-Fi Ban**. It has three tabs:

| Tab | What it does |
|---|---|
| **Devices** | Live list of connected Wi-Fi clients: name, MAC, IP, SSID, band, signal, rates, traffic, uptime. **Kick** or **Ban** each one. |
| **Ban list** | All rules: MAC rules and name rules, with the MACs each name rule has learned. Add, enable/disable, set an expiry, edit the label, unban. |
| **Settings** | Turn enforcement on or off, set the re-apply interval, kick cool-down, learned-MAC limit, a **never-ban list** for your own devices, and syslog logging. |

## Features

- Bans work on **every SSID and band** on the router (all `hostapd.*` interfaces). Banned devices are refused at auth/assoc, so they cannot connect at all.
- **Name bans** use the DHCP hostname, with wildcards `*` and `?` (e.g. `Galaxy-S23*`). When a device with a matching name asks for an IP, its MAC is banned at once and remembered in the rule.
- **Temporary bans**: 1 hour, 3 hours, 1 day, 1 week or 30 days. They lift themselves when they expire.
- Bans **survive reboots and `wifi reload`**: a small procd service re-applies them, and does so straight away when a Wi-Fi interface comes back.
- A **never-ban list**, so you cannot lock yourself out with a wide name pattern. A pattern also needs at least 2 non-wildcard characters, so `*` alone is rejected.
- A **`wban` CLI** for SSH and scripts.
- No Wi-Fi restart is needed to ban or unban, so other clients are never dropped.

## How it works

```
                 LuCI (Devices / Ban list / Settings)
                               │  ubus: luci.wban.*
                               ▼
   rpcd ucode plugin ── /usr/share/rpcd/ucode/luci.wban
                               │
                               ▼
               core module ── /usr/share/ucode/wban.uc  ◄── /usr/sbin/wban (CLI + daemon)
                 │        │                                  ▲
     /etc/config/wban     │ ubus hostapd.<if> del_client     │ check-lease
         (rules)          ▼   {addr, ban_time, deauth}       │
                    hostapd ban list           /etc/hotplug.d/dhcp/90-wban (dnsmasq)
```

- **MAC rule**: the MAC is put on hostapd's ban list on every interface.
- **Name rule**: when dnsmasq hands out a lease, the hotplug hook checks the hostname against the name rules. On a match, that MAC is added to the rule's `learned` list and banned. The daemon also checks connected clients on every pass, so a lease from before the rule was created is caught too.
- hostapd forgets bans when Wi-Fi restarts. Each ban is set with a lifetime of 3 × `interval` and renewed every `interval` seconds (30 s by default).

## Limitations

- A name ban only works if the device **sends a hostname** over DHCP. iPhones usually do (`Johns-iPhone`). Many Android phones in random-MAC mode send no hostname or a random one. A device with a static IP never asks for DHCP.
- A device with a new random MAC is banned **when it requests its lease**. It is associated for a moment first, then kicked and kept out.
- Someone who changes both their MAC and their hostname can get back in. Use WPA2/WPA3 with a password you control as the real access control. This tool is for managing devices.
- Needs OpenWrt's standard `hostapd` / `wpad` with ubus support. OpenWrt 23.05 or newer (ucode-based LuCI) is recommended.

## Install

### Build with the OpenWrt SDK or buildroot

This repo is a package feed. Add it to `feeds.conf`:

```
src-git wban https://github.com/nooblk-98/luci-app-wban.git
```

Then:

```sh
./scripts/feeds update wban luci
./scripts/feeds install luci-app-wban
make menuconfig          # LuCI → Applications → luci-app-wban
make package/luci-app-wban/compile V=s
```

You can also copy the `luci-app-wban/` folder into `package/` of your buildroot.

### Copy straight onto a running router (for testing)

```sh
scp -O -r luci-app-wban/root/* root@192.168.1.1:/
scp -O -r luci-app-wban/htdocs/* root@192.168.1.1:/www/
ssh root@192.168.1.1 'apk add ucode-mod-uloop 2>/dev/null || opkg install ucode-mod-uloop; \
  sh /etc/uci-defaults/80_luci-wban && rm /etc/uci-defaults/80_luci-wban; /etc/init.d/rpcd restart'
```

Then reload LuCI.

## CLI

```
wban clients                       list connected Wi-Fi devices
wban rules                         list ban rules
wban ban-mac aa:bb:cc:dd:ee:ff "Neighbour" 3600
wban ban-name 'Galaxy-S23*' "Kid tablet"
wban unban <id|mac|pattern>
wban enable|disable <id|mac|pattern>
wban forget <id|pattern> <mac>     drop a learned MAC from a name rule
wban kick <mac>
wban enforce | release-all | status
```

`ubus call luci.wban status` gives the same data the web UI uses.

## Configuration (`/etc/config/wban`)

```
config wban 'settings'
	option enabled '1'
	option interval '30'
	option kick_ban '10'
	option learn_limit '16'
	option log '1'
	list allow_mac 'aa:bb:cc:dd:ee:ff'

config rule
	option kind 'name'
	option value 'Galaxy-S23*'
	option label 'Kid tablet'
	option enabled '1'
	option added '1763100000'
	option expires '0'
	list learned 'de:ad:be:ef:00:01'
```

## Repository layout

```
luci-app-wban/
├── Makefile                                    OpenWrt package (luci.mk)
├── htdocs/luci-static/resources/
│   ├── wban.js                                 shared RPC, formatters, ban dialog
│   └── view/wban/{devices,rules,settings}.js   the three tabs
└── root/
    ├── etc/config/wban                         default config
    ├── etc/init.d/wban                         procd service (enforcer)
    ├── etc/hotplug.d/dhcp/90-wban              DHCP lease hook (name bans)
    ├── etc/uci-defaults/80_luci-wban           first-install setup
    └── usr/
        ├── sbin/wban                           CLI + daemon (ucode)
        └── share/
            ├── ucode/wban.uc                   core logic
            ├── rpcd/ucode/luci.wban            ubus object luci.wban
            ├── rpcd/acl.d/luci-app-wban.json   LuCI permissions
            └── luci/menu.d/luci-app-wban.json  menu entries
```

## License

MIT. See [LICENSE](LICENSE).
