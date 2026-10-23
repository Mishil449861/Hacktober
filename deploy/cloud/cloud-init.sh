#!/bin/bash
# Paste this into Oracle Cloud while creating the VM:
#   Create instance > Show advanced options > Management > "Paste cloud-init script"
# Fill in the values first. The VM then sets itself up on first boot (about 15-20 minutes);
# progress is in /var/log/orgmap-setup.log.
#
# TS_AUTHKEY: Tailscale admin console > Settings > Keys > Generate auth key. Leave "Reusable" OFF so the
# key is useless once used (cloud-init scripts stay readable from inside the VM).
# Cloudinary: optional, from the Cloudinary console > Settings > API Keys. Empty = photos on the VM's disk.

export TS_AUTHKEY=""
export TS_HOSTNAME="orgmap-cloud"
export CLOUDINARY_CLOUD_NAME=""
export CLOUDINARY_API_KEY=""
export CLOUDINARY_API_SECRET=""

curl -fsSL https://raw.githubusercontent.com/Mishil449861/Hacktober/main/deploy/cloud/setup.sh -o /root/orgmap-setup.sh
bash /root/orgmap-setup.sh > /var/log/orgmap-setup.log 2>&1
