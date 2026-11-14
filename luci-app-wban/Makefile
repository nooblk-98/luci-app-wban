# SPDX-License-Identifier: MIT
#
# luci-app-wban - list Wi-Fi clients, kick them, ban / unban them by MAC
# address or by device name.

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Wi-Fi client kick / ban manager
LUCI_DESCRIPTION:=Lists connected Wi-Fi devices and lets you kick, ban or \
	unban them on every hostapd SSID, by MAC address or by DHCP device name \
	(catches randomized MACs). Bans survive reboots and Wi-Fi restarts.
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +rpcd-mod-iwinfo \
	+ucode +ucode-mod-uci +ucode-mod-ubus +ucode-mod-fs +ucode-mod-uloop
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Lahiru S Liyanage <https://github.com/nooblk-98>

define Package/luci-app-wban/conffiles
/etc/config/wban
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
