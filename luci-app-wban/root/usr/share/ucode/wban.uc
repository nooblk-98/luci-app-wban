// SPDX-License-Identifier: MIT
//
// wban - Wi-Fi client kick / ban core.
//
// Shared by the rpcd plugin (LuCI), the `wban` CLI, the enforcement
// daemon and the DHCP hotplug hook, so all ban logic lives here.
//
// How bans work
// -------------
// hostapd keeps an in-memory ban list per interface, managed through
// `ubus call hostapd.<ifname> del_client {addr, ban_time}`. A banned
// station is refused at probe/auth/assoc time, so it cannot connect at
// all. That list is lost whenever Wi-Fi restarts, so the daemon
// re-applies every ban with a time-to-live of 3x its interval.
//
// Rules (UCI `config rule`) come in two kinds:
//   kind 'mac'   value is one MAC address.
//   kind 'name'  value is a hostname pattern (* and ? wildcards). When a
//                device whose DHCP hostname matches connects, its MAC is
//                "learned" into the rule and banned. A phone that switches
//                to a new random MAC therefore gets caught again as soon
//                as it asks for an IP address.

'use strict';

import { cursor } from 'uci';
import { connect } from 'ubus';
import { readfile } from 'fs';

const CONFIG = 'wban';
const LEASE_FILE = '/tmp/dhcp.leases';
const ARP_FILE = '/proc/net/arp';
const MAX_DURATION = 366 * 86400;
const MAX_LABEL = 64;

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

function to_int(value, def, min, max) {
	if (value == null || value == '')
		return def;

	let n = int(value);

	if (n != n)	/* NaN */
		return def;
	if (min != null && n < min)
		n = min;
	if (max != null && n > max)
		n = max;

	return n;
}

function to_bool(value, def) {
	if (value == null || value == '')
		return def;
	if (type(value) == 'bool')
		return value;

	return (value == '1' || value == 'true' || value == 'yes' || value == 'on');
}

function to_list(value) {
	if (type(value) == 'array')
		return value;
	if (type(value) == 'string' && length(trim(value)))
		return split(trim(value), /\s+/);

	return [];
}

function field(obj, key) {
	return (type(obj) == 'object') ? obj[key] : null;
}

function pick(a, b) {
	return (a != null) ? a : b;
}

export function normalize_mac(mac) {
	if (type(mac) != 'string')
		return null;

	mac = replace(lc(trim(mac)), /-/g, ':');

	return match(mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) ? mac : null;
}

function clean_label(label) {
	if (type(label) != 'string')
		return '';

	label = trim(replace(label, /[\r\n\t]+/g, ' '));

	return (length(label) > MAX_LABEL) ? substr(label, 0, MAX_LABEL) : label;
}

/* Hostname patterns: letters, digits, '.', '-', '_', space, '*', '?'.
 * At least two non-wildcard characters, so "*" cannot ban everyone. */
export function valid_pattern(pattern) {
	if (type(pattern) != 'string' || !match(pattern, /^[A-Za-z0-9._*? -]{1,63}$/))
		return false;

	return length(replace(pattern, /[*? ]/g, '')) >= 2;
}

function glob_regexp(pattern) {
	let src = '';

	for (let i = 0; i < length(pattern); i++) {
		let c = substr(pattern, i, 1);

		if (c == '*')
			src += '.*';
		else if (c == '?')
			src += '.';
		else if (c == '.')
			src += '\\.';
		else
			src += c;
	}

	return regexp('^' + src + '$', 'i');
}

function band_of(freq) {
	freq = to_int(freq, 0);

	if (!freq)
		return null;
	if (freq < 3000)
		return '2.4 GHz';
	if (freq < 5925)
		return '5 GHz';

	return '6 GHz';
}

/* ------------------------------------------------------------------ */
/* Context: one UCI cursor + one ubus connection per operation         */
/* ------------------------------------------------------------------ */

function read_settings(uci) {
	let s = uci.get_all(CONFIG, 'settings') || {};
	let allow = {};

	for (let m in to_list(s.allow_mac)) {
		m = normalize_mac(m);
		if (m)
			allow[m] = true;
	}

	return {
		enabled: to_bool(s.enabled, true),
		interval: to_int(s.interval, 30, 5, 3600),
		kick_ban: to_int(s.kick_ban, 10, 0, 3600),
		learn_limit: to_int(s.learn_limit, 16, 1, 256),
		log: to_bool(s.log, true),
		allow: allow
	};
}

function open_ctx() {
	let uci = cursor();

	uci.load(CONFIG);

	let ctx = {
		uci: uci,
		bus: connect(),
		now: time()
	};

	ctx.settings = read_settings(uci);

	return ctx;
}

function close_ctx(ctx) {
	if (ctx.bus) {
		try { ctx.bus.disconnect(); } catch (e) { }
		ctx.bus = null;
	}
}

function log_msg(ctx, msg) {
	if (ctx.settings.log)
		system([ 'logger', '-t', 'wban', msg ]);
}

function ucall(ctx, object, method, args) {
	if (!ctx.bus)
		return null;

	try {
		return ctx.bus.call(object, method, args || {});
	}
	catch (e) {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

function read_rules(ctx) {
	let rules = [];

	ctx.uci.foreach(CONFIG, 'rule', function(s) {
		let kind = (s.kind == 'name') ? 'name' : 'mac';
		let value = (kind == 'mac') ? normalize_mac(s.value) : trim(s.value || '');

		if (!value)
			return;

		let learned = [];

		for (let m in to_list(s.learned)) {
			m = normalize_mac(m);
			if (m && index(learned, m) < 0)
				push(learned, m);
		}

		let expires = to_int(s.expires, 0, 0);

		push(rules, {
			id: s['.name'],
			kind: kind,
			value: value,
			label: s.label || null,
			enabled: to_bool(s.enabled, true),
			added: to_int(s.added, 0, 0),
			expires: expires,
			expired: (expires > 0 && expires <= ctx.now),
			learned: learned
		});
	});

	return rules;
}

function is_active(rule) {
	return rule.enabled && !rule.expired;
}

function rule_macs(rule) {
	return (rule.kind == 'mac') ? [ rule.value ] : rule.learned;
}

/* Finds a rule by section id, MAC value or name pattern. */
function find_rule(rules, key) {
	if (type(key) != 'string' || !length(key))
		return null;

	let mac = normalize_mac(key);

	for (let r in rules) {
		if (r.id == key)
			return r;
		if (mac && r.kind == 'mac' && r.value == mac)
			return r;
		if (r.kind == 'name' && lc(r.value) == lc(trim(key)))
			return r;
	}

	return null;
}

/* Map of every MAC that must be kept out -> id of the rule banning it. */
function banned_macs(ctx, rules) {
	let macs = {};

	for (let r in rules) {
		if (!is_active(r))
			continue;

		for (let m in rule_macs(r))
			if (!ctx.settings.allow[m] && !macs[m])
				macs[m] = r.id;
	}

	return macs;
}

function find_name_rule(rules, hostname) {
	let name = trim(hostname || '');

	if (!length(name) || name == '*')
		return null;

	for (let r in rules)
		if (r.kind == 'name' && is_active(r) && match(name, glob_regexp(r.value)))
			return r;

	return null;
}

function has_name_rules(rules) {
	for (let r in rules)
		if (r.kind == 'name' && is_active(r))
			return true;

	return false;
}

function learn_mac(ctx, rule, mac) {
	if (index(rule.learned, mac) >= 0)
		return false;

	push(rule.learned, mac);

	while (length(rule.learned) > ctx.settings.learn_limit)
		shift(rule.learned);

	ctx.uci.set(CONFIG, rule.id, 'learned', rule.learned);
	ctx.uci.commit(CONFIG);

	return true;
}

/* Deletes expired rules; returns the MACs they were banning. */
function purge_expired(ctx, rules) {
	let macs = [];
	let changed = false;

	for (let r in rules) {
		if (!r.expired)
			continue;

		ctx.uci.delete(CONFIG, r.id);
		changed = true;

		for (let m in rule_macs(r))
			push(macs, m);

		log_msg(ctx, sprintf('rule %s "%s" expired', r.kind, r.value));
	}

	if (changed)
		ctx.uci.commit(CONFIG);

	return macs;
}

/* ------------------------------------------------------------------ */
/* hostapd / Wi-Fi                                                     */
/* ------------------------------------------------------------------ */

function hostapd_objects(ctx) {
	let objs = [];
	let all = ctx.bus ? ctx.bus.list() : null;

	for (let path in (all || []))
		if (type(path) == 'string' && index(path, 'hostapd.') == 0)
			push(objs, path);

	return sort(objs);
}

/* ms > 0: ban for that long. ms == 0: lift an existing ban.
 * Returns the number of interfaces the call was sent to. */
function hostapd_ban(ctx, mac, ms, deauth) {
	let n = 0;

	for (let obj in hostapd_objects(ctx)) {
		ucall(ctx, obj, 'del_client', {
			addr: mac,
			reason: 5,
			deauth: !!deauth,
			ban_time: ms
		});
		n++;
	}

	return n;
}

function ban_ttl(ctx) {
	return ctx.settings.interval * 3 * 1000;
}

/* Lifts hostapd bans for MACs that no remaining rule covers. */
function release_macs(ctx, macs) {
	let still = banned_macs(ctx, read_rules(ctx));
	let n = 0;

	for (let m in macs) {
		if (still[m])
			continue;

		hostapd_ban(ctx, m, 0, false);
		n++;
	}

	return n;
}

/* MAC -> { ip, hostname, static_name } from DHCP leases, static hosts and ARP. */
function read_hosts(ctx) {
	let hosts = {};

	let entry = function(mac) {
		mac = normalize_mac(mac);

		if (!mac)
			return null;
		if (!hosts[mac])
			hosts[mac] = {};

		return hosts[mac];
	};

	ctx.uci.load('dhcp');
	ctx.uci.foreach('dhcp', 'host', function(s) {
		for (let m in to_list(s.mac)) {
			let e = entry(m);

			if (e && s.name)
				e.static_name = s.name;
		}
	});

	for (let line in split(readfile(LEASE_FILE) || '', '\n')) {
		/* <expiry> <mac> <ip> <hostname|*> <client-id> */
		let f = split(trim(line), /\s+/);

		if (length(f) < 4)
			continue;

		let e = entry(f[1]);

		if (!e)
			continue;
		if (index(f[2], ':') < 0)
			e.ip = f[2];
		if (f[3] != '*')
			e.hostname = f[3];
	}

	let arp = split(readfile(ARP_FILE) || '', '\n');

	for (let i = 1; i < length(arp); i++) {
		/* IP HW-type Flags HW-address Mask Device */
		let f = split(trim(arp[i]), /\s+/);

		if (length(f) < 4 || f[2] == '0x0')
			continue;

		let e = entry(f[3]);

		if (e && !e.ip)
			e.ip = f[0];
	}

	return hosts;
}

function collect_wifi(ctx, hosts) {
	let ifaces = [];
	let clients = [];

	for (let obj in hostapd_objects(ctx)) {
		let ifname = substr(obj, length('hostapd.'));
		let hc = ucall(ctx, obj, 'get_clients') || {};
		let st = ucall(ctx, obj, 'get_status') || {};
		let info = ucall(ctx, 'iwinfo', 'info', { device: ifname }) || {};
		let assoclist = field(ucall(ctx, 'iwinfo', 'assoclist', { device: ifname }), 'results');
		let assoc = {};

		for (let a in (assoclist || [])) {
			let m = normalize_mac(a.mac);
			if (m)
				assoc[m] = a;
		}

		let freq = hc.freq || st.freq || info.frequency;
		let iface = {
			ifname: ifname,
			ssid: info.ssid || st.ssid || null,
			band: band_of(freq),
			channel: info.channel || st.channel || null,
			clients: 0
		};

		push(ifaces, iface);

		let stations = hc.clients || {};

		for (let raw in keys(stations)) {
			let mac = normalize_mac(raw);

			if (!mac)
				continue;

			let c = stations[raw];
			let a = assoc[mac] || {};
			let h = hosts[mac] || {};

			iface.clients++;

			push(clients, {
				mac: mac,
				ifname: ifname,
				ssid: iface.ssid,
				band: iface.band,
				hostname: h.hostname || null,
				name: h.static_name || h.hostname || null,
				ip: h.ip || null,
				signal: pick(a.signal, field(c, 'signal')),
				noise: a.noise,
				connected_time: pick(a.connected_time, field(c, 'connected_time')),
				inactive: a.inactive,
				rx_rate: field(a.rx, 'rate'),
				tx_rate: field(a.tx, 'rate'),
				rx_bytes: pick(field(a.rx, 'bytes'), field(field(c, 'bytes'), 'rx')),
				tx_bytes: pick(field(a.tx, 'bytes'), field(field(c, 'bytes'), 'tx')),
				authorized: to_bool(field(c, 'authorized'), true)
			});
		}
	}

	return { interfaces: ifaces, clients: clients };
}

function daemon_running(ctx) {
	let svc = ucall(ctx, 'service', 'list', { name: CONFIG });
	let instances = field(field(svc, CONFIG), 'instances') || {};

	for (let k in keys(instances))
		if (field(instances[k], 'running'))
			return true;

	return false;
}

/* ------------------------------------------------------------------ */
/* Enforcement                                                         */
/* ------------------------------------------------------------------ */

function ban_matching_clients(ctx, rules, clients, banned, stats) {
	for (let c in clients) {
		if (ctx.settings.allow[c.mac] || banned[c.mac])
			continue;

		let r = find_name_rule(rules, c.hostname);

		if (!r)
			continue;

		learn_mac(ctx, r, c.mac);
		banned[c.mac] = r.id;
		hostapd_ban(ctx, c.mac, ban_ttl(ctx), true);
		stats.learned++;

		log_msg(ctx, sprintf('banned %s: hostname "%s" matches rule "%s"', c.mac, c.hostname, r.value));
	}
}

function run_enforce(ctx) {
	let stats = { banned: 0, learned: 0, released: 0, interfaces: 0 };
	let rules = read_rules(ctx);
	let expired_macs = purge_expired(ctx, rules);

	if (length(expired_macs)) {
		stats.released += release_macs(ctx, expired_macs);
		rules = read_rules(ctx);
	}

	stats.interfaces = length(hostapd_objects(ctx));

	if (!ctx.settings.enabled)
		return stats;

	let banned = banned_macs(ctx, rules);
	let ttl = ban_ttl(ctx);

	for (let m in keys(banned)) {
		hostapd_ban(ctx, m, ttl, true);
		stats.banned++;
	}

	if (has_name_rules(rules))
		ban_matching_clients(ctx, rules, collect_wifi(ctx, read_hosts(ctx)).clients, banned, stats);

	return stats;
}

function export_settings(s) {
	return {
		enabled: s.enabled,
		interval: s.interval,
		kick_ban: s.kick_ban,
		learn_limit: s.learn_limit,
		log: s.log,
		allow_mac: sort(keys(s.allow))
	};
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/* Everything the Devices / Ban list pages need, in one call. */
export function status() {
	let ctx = open_ctx();
	let rules = read_rules(ctx);
	let wifi = collect_wifi(ctx, read_hosts(ctx));
	let banned = banned_macs(ctx, rules);

	for (let c in wifi.clients) {
		let r = find_name_rule(rules, c.hostname);

		c.allowed = !!ctx.settings.allow[c.mac];
		c.banned_by = banned[c.mac] || null;
		c.name_rule = (r && !c.allowed) ? r.id : null;
	}

	let res = {
		now: ctx.now,
		settings: export_settings(ctx.settings),
		daemon: daemon_running(ctx),
		interfaces: wifi.interfaces,
		clients: wifi.clients,
		rules: rules
	};

	close_ctx(ctx);

	return res;
}

/* Disconnects a station. It is kept out for `kick_ban` seconds so it
 * really drops instead of reconnecting instantly. */
export function kick(mac) {
	mac = normalize_mac(mac);

	if (!mac)
		return { error: 'Invalid MAC address' };

	let ctx = open_ctx();
	let banned = banned_macs(ctx, read_rules(ctx));
	let ms = banned[mac] ? ban_ttl(ctx) : ctx.settings.kick_ban * 1000;
	let n = hostapd_ban(ctx, mac, ms, true);

	if (n)
		log_msg(ctx, sprintf('kicked %s', mac));

	close_ctx(ctx);

	return n ? { ok: true } : { error: 'No hostapd Wi-Fi interfaces found' };
}

/* args: { kind: 'mac'|'name', value, label?, duration? (seconds, 0 = permanent) }
 * Adding a rule that already exists re-enables it and updates label/expiry. */
export function add_rule(args) {
	args = args || {};

	let kind = (args.kind == 'name') ? 'name' : 'mac';
	let value;

	if (kind == 'mac') {
		value = normalize_mac(args.value);
		if (!value)
			return { error: 'Invalid MAC address' };
	}
	else {
		value = trim(args.value || '');
		if (!valid_pattern(value))
			return { error: 'Invalid name pattern. Use letters, digits, ".", "-", "_", spaces and the wildcards * and ?, with at least 2 normal characters.' };
	}

	let duration = to_int(args.duration, 0, 0, MAX_DURATION);
	let label = clean_label(args.label);
	let ctx = open_ctx();

	if (kind == 'mac' && ctx.settings.allow[value]) {
		close_ctx(ctx);
		return { error: 'This MAC address is on the never-ban list (Settings tab)' };
	}

	let rule = find_rule(read_rules(ctx), value);

	if (rule && rule.kind != kind)
		rule = null;

	let id = rule ? rule.id : ctx.uci.add(CONFIG, 'rule');

	if (!rule) {
		ctx.uci.set(CONFIG, id, 'kind', kind);
		ctx.uci.set(CONFIG, id, 'value', value);
		ctx.uci.set(CONFIG, id, 'added', '' + ctx.now);
	}

	ctx.uci.set(CONFIG, id, 'enabled', '1');

	if (length(label))
		ctx.uci.set(CONFIG, id, 'label', label);

	if (duration > 0)
		ctx.uci.set(CONFIG, id, 'expires', '' + (ctx.now + duration));
	else
		ctx.uci.delete(CONFIG, id, 'expires');

	ctx.uci.commit(CONFIG);

	log_msg(ctx, sprintf('%s rule %s "%s"%s', rule ? 'updated' : 'added', kind, value,
		duration ? sprintf(' for %ds', duration) : ''));

	let stats = run_enforce(ctx);

	close_ctx(ctx);

	return { ok: true, id: id, learned: stats.learned };
}

/* args: { id, enabled?, label? }  (id may also be a MAC or name pattern) */
export function set_rule(args) {
	args = args || {};

	let ctx = open_ctx();
	let rule = find_rule(read_rules(ctx), args.id);

	if (!rule) {
		close_ctx(ctx);
		return { error: 'Rule not found' };
	}

	if (args.enabled != null)
		ctx.uci.set(CONFIG, rule.id, 'enabled', to_bool(args.enabled, true) ? '1' : '0');

	if (type(args.label) == 'string') {
		let label = clean_label(args.label);

		if (length(label))
			ctx.uci.set(CONFIG, rule.id, 'label', label);
		else
			ctx.uci.delete(CONFIG, rule.id, 'label');
	}

	ctx.uci.commit(CONFIG);

	if (args.enabled != null && !to_bool(args.enabled, true))
		release_macs(ctx, rule_macs(rule));

	run_enforce(ctx);
	close_ctx(ctx);

	return { ok: true, id: rule.id };
}

/* Deletes a rule (by id, MAC or name pattern) and lifts its bans. */
export function remove_rule(key) {
	let ctx = open_ctx();
	let rule = find_rule(read_rules(ctx), key);

	if (!rule) {
		close_ctx(ctx);
		return { error: 'Rule not found' };
	}

	ctx.uci.delete(CONFIG, rule.id);
	ctx.uci.commit(CONFIG);

	let released = release_macs(ctx, rule_macs(rule));

	log_msg(ctx, sprintf('removed rule %s "%s"', rule.kind, rule.value));
	close_ctx(ctx);

	return { ok: true, released: released };
}

/* Removes one learned MAC from a name rule (e.g. a false match). */
export function forget_mac(key, mac) {
	mac = normalize_mac(mac);

	if (!mac)
		return { error: 'Invalid MAC address' };

	let ctx = open_ctx();
	let rule = find_rule(read_rules(ctx), key);

	if (!rule || rule.kind != 'name') {
		close_ctx(ctx);
		return { error: 'Name rule not found' };
	}

	let learned = filter(rule.learned, function(m) { return m != mac; });

	if (length(learned))
		ctx.uci.set(CONFIG, rule.id, 'learned', learned);
	else
		ctx.uci.delete(CONFIG, rule.id, 'learned');

	ctx.uci.commit(CONFIG);
	release_macs(ctx, [ mac ]);
	close_ctx(ctx);

	return { ok: true };
}

/* Called by the DHCP hotplug hook whenever a lease is handed out. */
export function check_lease(mac, hostname) {
	mac = normalize_mac(mac);

	if (!mac || type(hostname) != 'string')
		return { ok: true, matched: false };

	let ctx = open_ctx();

	if (!ctx.settings.enabled || ctx.settings.allow[mac]) {
		close_ctx(ctx);
		return { ok: true, matched: false };
	}

	let rule = find_name_rule(read_rules(ctx), hostname);

	if (rule) {
		learn_mac(ctx, rule, mac);
		hostapd_ban(ctx, mac, ban_ttl(ctx), true);
		log_msg(ctx, sprintf('banned %s: DHCP hostname "%s" matches rule "%s"', mac, hostname, rule.value));
	}

	close_ctx(ctx);

	return { ok: true, matched: !!rule, rule: rule ? rule.id : null };
}

/* One enforcement pass (run by the daemon every `interval` seconds). */
export function enforce() {
	let ctx = open_ctx();
	let stats = run_enforce(ctx);

	stats.interval = ctx.settings.interval;
	stats.enabled = ctx.settings.enabled;

	close_ctx(ctx);

	return stats;
}

/* Lifts every hostapd ban without touching the rules. */
export function release_all() {
	let ctx = open_ctx();
	let n = 0;

	for (let r in read_rules(ctx))
		for (let m in rule_macs(r)) {
			hostapd_ban(ctx, m, 0, false);
			n++;
		}

	close_ctx(ctx);

	return { ok: true, released: n };
}

export function interval() {
	let uci = cursor();

	uci.load(CONFIG);

	return read_settings(uci).interval;
}
