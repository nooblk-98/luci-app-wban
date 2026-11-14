// SPDX-License-Identifier: MIT
//
// Devices tab: connected Wi-Fi stations with Kick / Ban actions.

'use strict';
'require view';
'require dom';
'require poll';
'require ui';
'require wban';

return view.extend({
	load: function() {
		return wban.status();
	},

	render: function(data) {
		this.filter = '';

		this.noticeBox = E('div');
		this.cardBox = E('div', { 'class': 'wban-cards' });

		this.table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Device')),
				E('th', { 'class': 'th' }, _('IP address')),
				E('th', { 'class': 'th' }, _('Network')),
				E('th', { 'class': 'th' }, _('Signal')),
				E('th', { 'class': 'th' }, _('Rate RX / TX (Mbit/s)')),
				E('th', { 'class': 'th' }, _('Traffic RX / TX')),
				E('th', { 'class': 'th' }, _('Connected')),
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		]);

		var search = E('input', {
			'class': 'cbi-input-text',
			'type': 'search',
			'placeholder': _('Filter by name, MAC, IP or SSID')
		});

		search.addEventListener('input', L.bind(function(ev) {
			this.filter = ev.target.value.trim().toLowerCase();
			this.update(this.data);
		}, this));

		var node = E([], [
			wban.style(),
			E('h2', {}, _('Wi-Fi Ban')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Devices connected to this router\'s Wi-Fi right now. <em>Kick</em> disconnects a device once. <em>Ban</em> keeps it off every SSID, by MAC address, by device name, or both.')),
			this.noticeBox,
			this.cardBox,
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'wban-toolbar' }, [ search ]),
				this.table
			])
		]);

		this.update(data);

		poll.add(L.bind(function() {
			return wban.status().then(L.bind(this.update, this));
		}, this), 5);

		return node;
	},

	refresh: function() {
		return wban.status().then(L.bind(this.update, this));
	},

	matchesFilter: function(c) {
		if (!this.filter)
			return true;

		return [ c.name, c.hostname, c.mac, c.ip, c.ssid, c.ifname ].some(L.bind(function(v) {
			return v != null && String(v).toLowerCase().indexOf(this.filter) > -1;
		}, this));
	},

	ruleById: function(id) {
		var rules = (this.data && this.data.rules) || [];

		for (var i = 0; i < rules.length; i++)
			if (rules[i].id == id)
				return rules[i];

		return null;
	},

	renderCards: function(data) {
		var ifaces = data.interfaces || [];
		var rules = data.rules || [];
		var active = rules.filter(function(r) { return r.enabled && !r.expired; }).length;
		var cards = ifaces.map(function(i) {
			return E('div', { 'class': 'wban-card' }, [
				E('strong', {}, wban.esc(i.ssid || i.ifname)),
				E('span', { 'class': 'wban-sub' }, [
					wban.esc([ i.band, i.channel ? _('ch %d').format(i.channel) : null, i.ifname ].filter(Boolean).join(' · '))
				]),
				E('div', {}, _('%d connected').format(i.clients))
			]);
		});

		cards.push(E('div', { 'class': 'wban-card' }, [
			E('strong', {}, _('%d ban rules').format(active)),
			E('span', { 'class': 'wban-sub' }, data.daemon ? _('Enforcer running') : _('Enforcer stopped')),
			E('div', {}, E('a', { 'href': L.url('admin/network/wban/rules') }, _('Manage ban list…')))
		]));

		return cards;
	},

	renderDevice: function(c) {
		var tags = [];

		if (c.allowed)
			tags.push(wban.badge(_('Never ban'), 'allow'));
		if (c.banned_by)
			tags.push(wban.badge(_('Banned'), 'active'));
		else if (c.name_rule)
			tags.push(wban.badge(_('Name matches a ban'), 'warn'));
		if (!c.authorized)
			tags.push(wban.badge(_('Not authorized'), 'off'));

		return E('div', {}, [
			E('strong', {}, c.name ? wban.esc(c.name) : _('Unknown device')),
			tags.length ? ' ' : '',
			E('span', {}, tags.reduce(function(acc, t) { acc.push(t, ' '); return acc; }, [])),
			E('br'),
			E('span', { 'class': 'wban-sub' }, [
				E('code', {}, wban.formatMac(c.mac)),
				(c.hostname && c.hostname != c.name) ? ' · ' + wban.esc(c.hostname) : ''
			])
		]);
	},

	renderActions: function(c) {
		var kick = E('button', {
			'class': 'btn cbi-button cbi-button-action',
			'title': _('Disconnect once; the device may reconnect'),
			'click': ui.createHandlerFn(this, function() {
				return wban.kick(c.mac).then(L.bind(this.refresh, this));
			})
		}, _('Kick'));

		var ban = E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'title': _('Keep this device off the Wi-Fi'),
			'click': ui.createHandlerFn(this, function() {
				return wban.showBanDialog(c).then(L.bind(function(changed) {
					if (changed)
						return this.refresh();
				}, this));
			})
		}, _('Ban'));

		if (c.allowed) {
			ban.disabled = true;
			ban.title = _('On the never-ban list (Settings)');
		}

		return E('div', { 'class': 'wban-actions' }, [ kick, ban ]);
	},

	update: function(data) {
		data = data || {};
		this.data = data;

		dom.content(this.noticeBox, wban.renderNotices(data));
		dom.content(this.cardBox, data.error ? [] : this.renderCards(data));

		var clients = (data.clients || []).filter(L.bind(this.matchesFilter, this));

		clients.sort(function(a, b) {
			return String(a.name || '~').localeCompare(String(b.name || '~')) || a.mac.localeCompare(b.mac);
		});

		var rows = clients.map(L.bind(function(c) {
			return [
				this.renderDevice(c),
				c.ip ? wban.esc(c.ip) : '-',
				E('div', {}, [
					wban.esc(c.ssid || c.ifname),
					E('br'),
					E('span', { 'class': 'wban-sub' }, wban.esc([ c.band, c.ifname ].filter(Boolean).join(' · ')))
				]),
				wban.formatSignal(c.signal),
				'%s / %s'.format(wban.formatRate(c.rx_rate), wban.formatRate(c.tx_rate)),
				'%s / %s'.format(wban.formatBytes(c.rx_bytes), wban.formatBytes(c.tx_bytes)),
				wban.formatDuration(c.connected_time),
				this.renderActions(c)
			];
		}, this));

		cbi_update_table(this.table, rows, E('em', {},
			this.filter ? _('No devices match the filter') : _('No Wi-Fi devices connected')));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
