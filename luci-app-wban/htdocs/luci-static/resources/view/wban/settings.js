// SPDX-License-Identifier: MIT
//
// Settings tab (plain UCI form on /etc/config/wban, section 'settings').

'use strict';
'require view';
'require form';
'require wban';

return view.extend({
	load: function() {
		return wban.status();
	},

	render: function(data) {
		var m, s, o;
		var clients = (data && data.clients) || [];

		m = new form.Map('wban', _('Wi-Fi Ban: settings'),
			_('Bans are applied through hostapd on every Wi-Fi interface. hostapd forgets them when Wi-Fi restarts, so a small service re-applies them on a fixed interval.'));

		s = m.section(form.NamedSection, 'settings', 'wban');
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable enforcement'),
			_('When off, rules are kept but nothing is blocked. Existing bans expire within three intervals.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'interval', _('Re-apply interval'),
			_('Seconds between enforcement passes. Each hostapd ban lasts 3× this long and is renewed every pass.'));
		o.datatype = 'range(5,3600)';
		o.placeholder = '30';

		o = s.option(form.Value, 'kick_ban', _('Kick cool-down'),
			_('After <em>Kick</em>, keep the device out this many seconds so it really drops. 0 = it may reconnect immediately.'));
		o.datatype = 'range(0,3600)';
		o.placeholder = '10';

		o = s.option(form.Value, 'learn_limit', _('MACs remembered per name rule'),
			_('Name rules remember every MAC seen with a matching hostname. The oldest are dropped past this limit.'));
		o.datatype = 'range(1,256)';
		o.placeholder = '16';

		o = s.option(form.DynamicList, 'allow_mac', _('Never ban'),
			_('Safety list: these devices are never banned or kicked by rules, even if a name pattern matches. Add your own phone and PC here.'));
		o.datatype = 'macaddr';
		clients.forEach(function(c) {
			o.value(c.mac, '%h (%h)'.format(wban.formatMac(c.mac), c.name || c.ssid || c.ifname));
		});

		o = s.option(form.Flag, 'log', _('Log to syslog'),
			_('Write kicks, bans and learned MACs to the system log (tag <code>wban</code>).'));
		o.default = '1';
		o.rmempty = false;

		return m.render();
	}
});
