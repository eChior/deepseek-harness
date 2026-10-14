#!/bin/bash
# Installer hooks for this distribution's Linux desktop package.
#
# electron-builder renders this file with the same placeholders as its stock template
# (${executable}, ${sanitizedProductName}), so the first block keeps the stock behaviour and
# the blocks that follow cover domestic Linux distributions (Kylin/UOS) where that behaviour
# leaves the application unable to start or missing from the application menu.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# The SUID bit is set unconditionally. Kylin ships kernels where the user-namespace probe used
# by the stock script succeeds while the Chromium sandbox still refuses to start, which shows up
# as an immediate exit or a segmentation fault before any window appears.
if [ -f '/opt/${sanitizedProductName}/chrome-sandbox' ]; then
    chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' || true
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

# Chromium resolves its ozone platform before the main bundle is evaluated, so the
# app.commandLine.appendSwitch() in main.ts lands too late: on Kylin the app still starts on
# Wayland and dies before a window appears, and only a hand-typed --ozone-platform=x11 gets it
# running. Put the switches on the launcher itself so a menu click behaves like that command line:
# X11 for the backend, and the panel's 1.5 scale for the 2160x1440 screens this build targets.
MENU_ENTRY='/usr/share/applications/${executable}.desktop'
if [ -f "$MENU_ENTRY" ] && ! grep -q -- '--ozone-platform' "$MENU_ENTRY"; then
    sed -i 's|^\(Exec="[^"]*"\) |\1 --ozone-platform=x11 --force-device-scale-factor=1.5 |' "$MENU_ENTRY" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Themes that index hicolor cache the directory; without a refresh the application-menu entry
# shows a placeholder icon until the user logs in again. Only an existing cache is refreshed, and
# without -f: rebuilding a full hicolor cache from scratch is the slowest step of this script on
# the arm64 machines this build targets, while the tool's own staleness check already notices the
# icons that were just installed.
HICOLOR_DIR='/usr/share/icons/hicolor'
if [ -f "$HICOLOR_DIR/icon-theme.cache" ] && hash gtk-update-icon-cache 2>/dev/null; then
    gtk-update-icon-cache -t "$HICOLOR_DIR" || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
