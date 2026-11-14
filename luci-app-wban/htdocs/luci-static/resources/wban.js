// SPDX-License-Identifier: MIT
//
// Shared RPC calls, formatters and dialogs for the luci-app-wban views.

'use strict';
'require baseclass';
'require rpc';
'require ui';

var callStatus = rpc.declare({
	object: 'luci.wban',
	method: 'status'
});

var callKick = rpc.declare({
	object: 'luci.wban',
	method: 'kick',
	params: [ 'mac' ]
});

var callAddRule = rpc.declare({
	object: 'luci.wban',
	method: 'add_rule',
	params: [ 'kind', 'value', 'label', 'duration' ]
});

var callSetRule = rpc.declare({
	object: 'luci.wban',
	method: 'set_rule',
	params: [ 'id', 'enabled', 'label' ]
});

var callRemoveRule = rpc.declare({
	object: 'luci.wban',
	method: 'remove_rule',
	params: [ 'id' ]
});

var callForgetMac = rpc.declare({
	object: 'luci.wban',
	method: 'forget_mac',
	params: [ 'id', 'mac' ]
});

var MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
var PATTERN_RE = /^[A-Za-z0-9._*? -]{1,63}$/;

function errorText(err) {
	return (err && err.message) ? err.message : String(err);
}

return baseclass.extend({
	durations: [
		[ 0, _('Permanent') ],
		[ 3600, _('1 hour') ],
		[ 3 * 3600, _('3 hours') ],
		[ 86400, _('1 day') ],
		[ 7 * 86400, _('1 week') ],
		[ 30 * 86400, _('30 days') ]
	],

	/* ---------------------------------------------------------------- */
	/* RPC                                                              */
	/* ---------------------------------------------------------------- */

	status: function() {
		return callStatus().catch(function(err) {
			return { error: errorText(err) };
		});
	},

	/* Runs an RPC promise, shows the outcome, resolves to the reply or null. */
	run: function(promise, okMessage) {
		return promise.then(function(res) {
			if (res && res.error)
				throw new Error(res.error);

			if (okMessage) {
				if (ui.addTimeLimitedNotification)
					ui.addTimeLimitedNotification(null, E('p', okMessage), 4000, 'info');
				else
					ui.addNotification(null, E('p', okMessage), 'info');
			}

			return res;
		}).catch(function(err) {
			ui.addNotification(null, E('p', errorText(err)), 'danger');
			return null;
		});
	},

	kick: function(mac) {
		return this.run(callKick(mac), _('%h was disconnected').format(this.formatMac(mac)));
	},

	/* Creates a rule; rejects with the backend error message. */
	submitRule: function(kind, value, label, duration) {
		return callAddRule(kind, String(value).trim(), label || '', +duration || 0).then(function(res) {
			if (res && res.error)
				throw new Error(res.error);

			return res;
		});
	},

	ruleAddedMessage: function(kind, value) {
		return (kind == 'name')
			? _('Device name "%h" is banned').format(value)
			: _('%h is banned').format(this.formatMac(value));
	},

	addRule: function(kind, value, label, duration) {
		return this.run(this.submitRule(kind, value, label, duration), this.ruleAddedMessage(kind, value));
	},

	setRuleEnabled: function(rule, enabled) {
		return this.run(callSetRule(rule.id, !!enabled),
			enabled ? _('Rule enabled') : _('Rule disabled, its bans are lifted'));
	},

	setRuleLabel: function(rule, label) {
		/* `enabled` left undefined so it is omitted from the request */
		return this.run(callSetRule(rule.id, undefined, label || ''), _('Label saved'));
	},

	removeRule: function(rule) {
		return this.run(callRemoveRule(rule.id), _('Unbanned "%h"').format(this.ruleValue(rule)));
	},

	forgetMac: function(rule, mac) {
		return this.run(callForgetMac(rule.id, mac), _('%h removed from the rule').format(this.formatMac(mac)));
	},

	/* ---------------------------------------------------------------- */
	/* Validation & formatting                                          */
	/* ---------------------------------------------------------------- */

	/* HTML-escape: LuCI renders string children as HTML, and hostnames come from the device. */
	esc: function(value) {
		return (value == null) ? "" : "%h".format(value);
	},

	isMac: function(value) {
		return MAC_RE.test(String(value || '').trim());
	},

	isPattern: function(value) {
		value = String(value || '').trim();
		return PATTERN_RE.test(value) && value.replace(/[*? ]/g, '').length >= 2;
	},

	formatMac: function(mac) {
		return String(mac || '').toUpperCase();
	},

	ruleValue: function(rule) {
		return (rule.kind == 'mac') ? this.formatMac(rule.value) : rule.value;
	},

	formatSignal: function(dbm) {
		if (dbm == null || isNaN(dbm))
			return E('span', {}, '-');

		var q = Math.min(Math.max(2 * (dbm + 100), 0), 100);

		/* LuCI 25.x ships signal-000-025.svg; older releases signal-0-25.png */
		var icon = (q <= 0) ? [ 'signal-000-000.svg', 'signal-0.png' ]
			: (q < 25) ? [ 'signal-000-025.svg', 'signal-0-25.png' ]
			: (q < 50) ? [ 'signal-025-050.svg', 'signal-25-50.png' ]
			: (q < 75) ? [ 'signal-050-075.svg', 'signal-50-75.png' ]
			: [ 'signal-075-100.svg', 'signal-75-100.png' ];

		var img = E('img', { 'src': L.resource('icons/' + icon[0]), 'alt': '' });

		img.addEventListener('error', function onError() {
			img.removeEventListener('error', onError);
			img.src = L.resource('icons/' + icon[1]);
		});

		return E('span', { 'class': 'wban-signal', 'title': _('Signal quality %d%%').format(q) }, [
			img, ' ', '%d dBm'.format(dbm)
		]);
	},

	formatRate: function(kbit) {
		return (kbit > 0) ? '%.1f'.format(kbit / 1000) : '-';
	},

	formatBytes: function(bytes) {
		return (bytes > 0) ? '%1024.1mB'.format(bytes) : '-';
	},

	formatDuration: function(secs) {
		return (secs > 0) ? '%t'.format(secs) : '-';
	},

	formatDate: function(ts) {
		return (ts > 0) ? new Date(ts * 1000).toLocaleString() : '-';
	},

	formatExpiry: function(rule, now) {
		if (!rule.expires)
			return _('Never');

		var left = rule.expires - now;

		return (left > 0)
			? E('span', { 'title': this.formatDate(rule.expires) }, _('in %s').format('%t'.format(left)))
			: _('Expired');
	},

	badge: function(text, kind) {
		return E('span', { 'class': 'wban-badge wban-badge-' + kind }, text);
	},

	/* Banner with daemon / interface warnings. */
	renderNotices: function(data) {
		var notes = [];

		if (data.error)
			notes.push(_('Cannot reach the wban backend: %h. Try "/etc/init.d/rpcd restart" on the router.').format(data.error));
		else {
			if (data.settings && !data.settings.enabled)
				notes.push(_('Enforcement is disabled in Settings. Rules are kept but nothing is blocked.'));
			else if (!data.daemon)
				notes.push(_('The wban service is not running, so bans will not survive a Wi-Fi restart. Run "/etc/init.d/wban start".'));

			if (Array.isArray(data.interfaces) && !data.interfaces.length)
				notes.push(_('No hostapd Wi-Fi interfaces found. Is Wi-Fi enabled?'));
		}

		return E('div', {}, notes.map(function(n) {
			return E('div', { 'class': 'alert-message warning' }, n);
		}));
	},

	durationSelect: function() {
		return E('select', { 'class': 'cbi-input-select' }, this.durations.map(function(d) {
			return E('option', { 'value': d[0] }, d[1]);
		}));
	},

	/* ---------------------------------------------------------------- */
	/* Dialogs                                                          */
	/* ---------------------------------------------------------------- */

	confirm: function(title, message, actionLabel) {
		return new Promise(function(resolve) {
			ui.showModal(title, [
				E('p', {}, message),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() { ui.hideModal(); resolve(false); }
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': function() { ui.hideModal(); resolve(true); }
					}, actionLabel)
				])
			]);
		});
	},

	/* Ban dialog for a connected client: ban by MAC, by name, or both.
	 * Resolves to true when at least one rule was created. */
	showBanDialog: function(client) {
		var self = this;
		var hostname = client.hostname || '';
		var error = E('div', { 'class': 'alert-message error', 'style': 'display:none' });

		var byMac = E('input', { 'type': 'checkbox', 'id': 'wban-by-mac', 'checked': 'checked' });
		var byNameAttrs = { 'type': 'checkbox', 'id': 'wban-by-name' };
		var patternAttrs = { 'class': 'cbi-input-text', 'type': 'text', 'value': hostname, 'placeholder': _('e.g. Galaxy-S23*') };

		if (hostname)
			byNameAttrs.checked = 'checked';
		else
			patternAttrs.disabled = 'disabled';

		var byName = E('input', byNameAttrs);
		var pattern = E('input', patternAttrs);
		var label = E('input', { 'class': 'cbi-input-text', 'type': 'text', 'value': client.name || hostname, 'placeholder': _('Optional note') });
		var duration = this.durationSelect();

		byName.addEventListener('change', function() {
			pattern.disabled = !byName.checked;
		});

		function row(title, field, help) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, title),
				E('div', { 'class': 'cbi-value-field' }, [
					field,
					help ? E('div', { 'class': 'cbi-value-description' }, help) : ''
				])
			]);
		}

		function fail(msg) {
			error.textContent = msg;
			error.style.display = '';
			return Promise.resolve();
		}

		return new Promise(function(resolve) {
			var submit = function() {
				var ruleLabel = label.value.trim();
				var secs = +duration.value || 0;
				var namePattern = pattern.value.trim();

				if (!byMac.checked && !byName.checked)
					return fail(_('Choose at least one: MAC address or device name.'));

				if (byName.checked && !self.isPattern(namePattern))
					return fail(_('Name pattern: letters, digits, . - _ space, wildcards * and ?, and at least 2 normal characters.'));

				var done = [];
				var chain = Promise.resolve();

				error.style.display = 'none';

				if (byMac.checked)
					chain = chain.then(function() {
						return self.submitRule('mac', client.mac, ruleLabel, secs).then(function() {
							done.push(self.ruleAddedMessage('mac', client.mac));
						});
					});

				if (byName.checked)
					chain = chain.then(function() {
						return self.submitRule('name', namePattern, ruleLabel, secs).then(function() {
							done.push(self.ruleAddedMessage('name', namePattern));
						});
					});

				/* On error keep the dialog open and show why; re-submitting is
				 * safe because adding an existing rule just updates it. */
				return chain.then(function() {
					ui.hideModal();
					self.run(Promise.resolve({}), done.join(' · '));
					resolve(true);
				}).catch(function(err) {
					return fail(errorText(err));
				});
			};

			ui.showModal(_('Ban device'), [
				E('p', {}, _('Block this device from every Wi-Fi network on the router. It is disconnected now and kept out until you unban it.')),
				error,
				E('div', { 'class': 'cbi-section' }, [
					row(_('By MAC address'), E('label', {}, [ byMac, ' ', E('code', {}, self.formatMac(client.mac)) ])),
					row(_('By device name'), E('div', {}, [ E('label', {}, [ byName, ' ', pattern ]) ]),
						hostname
							? _('Catches the device again when it changes to a new random MAC and asks for an IP address. Wildcards * and ? are allowed.')
							: _('This device did not send a name over DHCP, so only a MAC ban is possible.')),
					row(_('Label'), label),
					row(_('Duration'), duration)
				]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() { ui.hideModal(); resolve(false); }
					}, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button-negative',
						'click': ui.createHandlerFn(self, submit)
					}, _('Ban'))
				])
			]);
		});
	},

	/* Stylesheet shared by all wban pages. */
	style: function() {
		return E('style', {}, [
			'.wban-badge { display:inline-block; padding:0 .45em; border-radius:3px; font-size:85%; line-height:1.6em; color:#fff; background:#888; white-space:nowrap }',
			'.wban-badge-mac { background:#3d7ecc }',
			'.wban-badge-name { background:#8a54c4 }',
			'.wban-badge-active { background:#c43c3c }',
			'.wban-badge-off { background:#888 }',
			'.wban-badge-allow { background:#3a9a4b }',
			'.wban-badge-warn { background:#d48a1c }',
			'.wban-signal img { vertical-align:middle; width:16px; height:16px }',
			'.wban-sub { font-size:85%; opacity:.75 }',
			'.wban-actions { white-space:nowrap; text-align:right }',
			'.wban-actions .btn, .wban-actions .cbi-button { margin-left:.25em }',
			'.wban-toolbar { display:flex; flex-wrap:wrap; gap:.5em; align-items:center; margin:.5em 0 1em }',
			'.wban-toolbar input, .wban-toolbar select { width:auto; min-width:10em }',
			'.wban-toolbar input[type="search"] { min-width:22em; max-width:100% }',
			'.wban-cards { display:flex; flex-wrap:wrap; gap:.75em; margin-bottom:1em }',
			'.wban-card { flex:1 1 12em; padding:.6em .8em; border:1px solid rgba(128,128,128,.35); border-radius:4px }',
			'.wban-card strong { display:block; font-size:110% }',
			'.wban-learned code { margin-right:.35em }',
			'.wban-learned a { cursor:pointer; margin-right:.6em }'
		].join('\n'));
	}
});
