// SPDX-License-Identifier: MIT
//
// Ban list tab: MAC and device-name rules with add / enable / unban.

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
		this.noticeBox = E('div');

		this.table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Type')),
				E('th', { 'class': 'th' }, _('Match')),
				E('th', { 'class': 'th' }, _('Label')),
				E('th', { 'class': 'th' }, _('Added')),
				E('th', { 'class': 'th' }, _('Expires')),
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th cbi-section-actions' }, '')
			])
		]);

		var node = E([], [
			wban.style(),
			E('h2', {}, _('Wi-Fi Ban: ban list')),
			E('div', { 'class': 'cbi-map-descr' },
				_('<strong>MAC</strong> rules block one hardware address. <strong>Name</strong> rules block any device whose DHCP hostname matches (wildcards <code>*</code> and <code>?</code>). Every MAC seen with that name is remembered, so a phone that switches to a new random MAC is banned again as soon as it asks for an IP address.')),
			this.noticeBox,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Add a ban')),
				this.renderAddForm()
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Rules')),
				this.table
			])
		]);

		this.update(data);

		poll.add(L.bind(this.refresh, this), 10);

		return node;
	},

	refresh: function() {
		return wban.status().then(L.bind(this.update, this));
	},

	renderAddForm: function() {
		var kind = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'mac' }, _('MAC address')),
			E('option', { 'value': 'name' }, _('Device name'))
		]);
		var value = E('input', { 'class': 'cbi-input-text', 'type': 'text', 'placeholder': 'AA:BB:CC:DD:EE:FF' });
		var label = E('input', { 'class': 'cbi-input-text', 'type': 'text', 'placeholder': _('Label (optional)') });
		var duration = wban.durationSelect();

		kind.addEventListener('change', function() {
			value.placeholder = (kind.value == 'name') ? _('e.g. Galaxy-S23* or Johns-iPhone') : 'AA:BB:CC:DD:EE:FF';
		});

		var submit = E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'click': ui.createHandlerFn(this, function() {
				var v = value.value.trim();

				if (kind.value == 'mac' && !wban.isMac(v)) {
					ui.addNotification(null, E('p', _('Enter a MAC address like AA:BB:CC:DD:EE:FF.')), 'warning');
					return;
				}

				if (kind.value == 'name' && !wban.isPattern(v)) {
					ui.addNotification(null, E('p', _('Name pattern: letters, digits, . - _ space, wildcards * and ?, and at least 2 normal characters.')), 'warning');
					return;
				}

				return wban.addRule(kind.value, v, label.value.trim(), duration.value).then(L.bind(function(res) {
					if (res) {
						value.value = '';
						label.value = '';
					}

					return this.refresh();
				}, this));
			})
		}, _('Ban'));

		return E('div', { 'class': 'wban-toolbar' }, [ kind, value, label, duration, submit ]);
	},

	renderMatch: function(rule) {
		var main = E('code', {}, wban.esc(wban.ruleValue(rule)));

		if (rule.kind != 'name')
			return main;

		var learned = rule.learned || [];

		if (!learned.length)
			return E('div', {}, [ main, E('br'), E('span', { 'class': 'wban-sub' }, _('No MAC seen with this name yet')) ]);

		return E('div', {}, [
			main,
			E('div', { 'class': 'wban-sub wban-learned' }, [ _('Learned:'), ' ' ].concat(learned.map(L.bind(function(mac) {
				return E('span', {}, [
					E('code', {}, wban.formatMac(mac)),
					E('a', {
						'title': _('Forget this MAC (if it was a false match)'),
						'click': ui.createHandlerFn(this, function() {
							return wban.forgetMac(rule, mac).then(L.bind(this.refresh, this));
						})
					}, '✕')
				]);
			}, this))))
		]);
	},

	renderLabel: function(rule) {
		var edit = E('a', {
			'class': 'wban-sub',
			'style': 'cursor:pointer; margin-left:.4em',
			'title': _('Edit label'),
			'click': ui.createHandlerFn(this, 'handleEditLabel', rule)
		}, '✎');

		return E('span', {}, [ rule.label ? wban.esc(rule.label) : '-', edit ]);
	},

	renderStatus: function(rule) {
		if (rule.expired)
			return wban.badge(_('Expired'), 'off');

		return rule.enabled ? wban.badge(_('Active'), 'active') : wban.badge(_('Disabled'), 'off');
	},

	renderActions: function(rule) {
		var toggle = E('button', {
			'class': 'btn cbi-button ' + (rule.enabled ? 'cbi-button-neutral' : 'cbi-button-apply'),
			'click': ui.createHandlerFn(this, function() {
				return wban.setRuleEnabled(rule, !rule.enabled).then(L.bind(this.refresh, this));
			})
		}, rule.enabled ? _('Disable') : _('Enable'));

		var remove = E('button', {
			'class': 'btn cbi-button cbi-button-remove',
			'click': ui.createHandlerFn(this, 'handleRemove', rule)
		}, _('Unban'));

		return E('div', { 'class': 'wban-actions' }, [ toggle, remove ]);
	},

	handleRemove: function(rule) {
		var msg = (rule.kind == 'name')
			? _('Remove the name rule "%h"? All %d learned MAC addresses are unbanned too.').format(rule.value, (rule.learned || []).length)
			: _('Unban %h?').format(wban.formatMac(rule.value));

		return wban.confirm(_('Unban'), msg, _('Unban')).then(L.bind(function(ok) {
			if (ok)
				return wban.removeRule(rule).then(L.bind(this.refresh, this));
		}, this));
	},

	handleEditLabel: function(rule) {
		var input = E('input', { 'class': 'cbi-input-text', 'type': 'text', 'value': rule.label || '', 'style': 'width:100%' });
		var self = this;

		ui.showModal(_('Edit label'), [
			E('p', {}, input),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-positive',
					'click': ui.createHandlerFn(this, function() {
						return wban.setRuleLabel(rule, input.value.trim()).then(function() {
							ui.hideModal();
							return self.refresh();
						});
					})
				}, _('Save'))
			])
		]);

		input.focus();
	},

	update: function(data) {
		data = data || {};
		this.data = data;

		dom.content(this.noticeBox, wban.renderNotices(data));

		var now = data.now || Math.floor(Date.now() / 1000);
		var rules = (data.rules || []).slice().sort(function(a, b) {
			return (b.added || 0) - (a.added || 0);
		});

		var rows = rules.map(L.bind(function(rule) {
			return [
				wban.badge(rule.kind == 'name' ? _('Name') : _('MAC'), rule.kind),
				this.renderMatch(rule),
				this.renderLabel(rule),
				wban.formatDate(rule.added),
				wban.formatExpiry(rule, now),
				this.renderStatus(rule),
				this.renderActions(rule)
			];
		}, this));

		cbi_update_table(this.table, rows, E('em', {}, _('Nothing is banned')));
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
