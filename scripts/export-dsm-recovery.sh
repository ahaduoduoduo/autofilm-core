#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  printf 'usage: %s OUTPUT_DIRECTORY\n' "$0" >&2
  exit 2
fi

output_dir="$1"
synowebapi="/usr/syno/bin/synowebapi"
synoshare="/usr/syno/sbin/synoshare"

mkdir -p "$output_dir/api" "$output_dir/config" "$output_dir/shares"

capture() {
  target="$1"
  shift
  {
    printf '$'
    for argument in "$@"; do
      printf ' %s' "$argument"
    done
    printf '\n'
    "$@"
  } >"$target" 2>&1 || true
}

capture_api() {
  target="$1"
  api="$2"
  version="$3"
  method="$4"
  shift 4
  "$synowebapi" --exec api="$api" version="$version" method="$method" "$@" 2>&1 \
    | awk 'found || /^\{/ { found = 1; print }' >"$target"
}

cp -p /etc.defaults/VERSION "$output_dir/config/etc.defaults.VERSION"
cp -p /etc/VERSION "$output_dir/config/etc.VERSION"
cp -p /etc/passwd "$output_dir/config/passwd"
cp -p /etc/group "$output_dir/config/group"
cp -p /etc/hosts "$output_dir/config/hosts"
cp -p /etc/resolv.conf "$output_dir/config/resolv.conf"
cp -p /etc/synoinfo.conf "$output_dir/config/synoinfo.conf"
cp -p /etc.defaults/synoinfo.conf "$output_dir/config/synoinfo.defaults.conf"

/usr/syno/bin/synoconfbkp export --filepath="$output_dir/dsm-config.dss"
/usr/syno/bin/synopkg list >"$output_dir/packages.txt"
/usr/syno/bin/synopkg list --name >"$output_dir/package-names.txt"

capture "$output_dir/system.txt" uname -a
capture "$output_dir/storage.txt" df -PT
capture "$output_dir/block-devices.json" lsblk -J -o NAME,PATH,SIZE,TYPE,FSTYPE,LABEL,UUID,MOUNTPOINTS
capture "$output_dir/network-addresses.json" ip -j address show
capture "$output_dir/network-routes.json" ip -j route show table all
capture "$output_dir/listening-ports.txt" ss -lntup
capture "$output_dir/scheduled-tasks.txt" /usr/syno/bin/synoschedtask --get
capture "$output_dir/running-services.txt" /usr/syno/bin/synosystemctl list-units --type=service --state=running
capture "$output_dir/package-storage-kib.txt" du -sk /volume1/@appconf/* /volume1/@appdata/*
capture "$output_dir/special-storage-kib.txt" du -sk /volume1/@GuestImage /volume1/@iSCSI /volume1/@database /volume1/@config_backup
capture "$output_dir/vmm-guests.txt" /usr/local/bin/virsh list --all
capture "$output_dir/vmm-storage-pools.txt" /usr/local/bin/virsh pool-list --all

capture_api "$output_dir/api/system-status.json" SYNO.Core.System.Status 1 get
capture_api "$output_dir/api/network.json" SYNO.Core.Network 2 get
capture_api "$output_dir/api/network-interfaces.json" SYNO.Core.Network.Interface 1 list
capture_api "$output_dir/api/shares.json" SYNO.Core.Share 1 list
capture_api "$output_dir/api/users.json" SYNO.Core.User 1 list
capture_api "$output_dir/api/groups.json" SYNO.Core.Group 1 list
capture_api "$output_dir/api/smb.json" SYNO.Core.FileServ.SMB 3 get
capture_api "$output_dir/api/nfs.json" SYNO.Core.FileServ.NFS 2 get
capture_api "$output_dir/api/ftp.json" SYNO.Core.FileServ.FTP 1 get
capture_api "$output_dir/api/terminal.json" SYNO.Core.Terminal 1 get
capture_api "$output_dir/api/reverse-proxy.json" SYNO.Core.AppPortal.ReverseProxy 1 list
capture_api "$output_dir/api/app-portals.json" SYNO.Core.AppPortal 2 list
capture_api "$output_dir/api/certificates.json" SYNO.Core.Certificate.CRT 1 list
capture_api "$output_dir/api/firewall.json" SYNO.Core.Security.Firewall 1 get
capture_api "$output_dir/api/firewall-profiles.json" SYNO.Core.Security.Firewall.Profile 1 list
capture_api "$output_dir/api/tasks.json" SYNO.Core.TaskScheduler 3 list

"$synoshare" --enum ALL >"$output_dir/shares-enum.txt"
sed -n '/Listed:/,$p' "$output_dir/shares-enum.txt" | sed '1d' \
  >"$output_dir/share-names.txt"
while IFS= read -r share_name; do
  [ -n "$share_name" ] || continue
  safe_name="$(printf '%s' "$share_name" | tr -c 'A-Za-z0-9._-' '_')"
  capture "$output_dir/shares/$safe_name.txt" "$synoshare" --get "$share_name"
  share_path="$("$synoshare" --get "$share_name" 2>/dev/null \
    | sed -n 's/^[[:space:]]*Path [.]\+\[\(.*\)\]$/\1/p' | head -n 1)"
  if [ -n "$share_path" ] && [ -e "$share_path" ]; then
    capture "$output_dir/shares/$safe_name.acl.txt" /usr/syno/bin/synoacltool -get "$share_path"
  fi
done <"$output_dir/share-names.txt"

jq -n \
  --arg schema_version "1" \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg hostname "$(hostname)" \
  --arg dsm_version "$(. /etc.defaults/VERSION; printf '%s-%s' "${productversion:-unknown}" "${buildnumber:-unknown}")" \
  '{
    schema_version: ($schema_version | tonumber),
    generated_at: $generated_at,
    hostname: $hostname,
    dsm_version: $dsm_version,
    restore_order: [
      "install a compatible DSM release",
      "import dsm-config.dss on Synology targets",
      "recreate users, groups, shared folders and ACLs from api/ and shares/",
      "restore network, SMB, certificates, reverse proxies, firewall and scheduled tasks",
      "install packages from packages.txt",
      "restore application data and then use the Docker recovery directory"
    ],
    portability: {
      synology: "dsm-config.dss plus the readable facts are used together",
      other_linux_nas: "use the readable facts as a migration specification; DSM-specific exports are reference-only"
    }
  }' >"$output_dir/manifest.json"

printf '%s\n' \
  '# DSM 重建顺序' \
  '' \
  '此目录同时保存群晖原生配置导出和可由 AI、管理员直接读取的系统事实。' \
  '' \
  '1. 安装与 `manifest.json` 记录相近的 DSM 版本。' \
  '2. 在群晖目标上导入 `dsm-config.dss`，再以 `api/` 和 `shares/` 核对遗漏项。' \
  '3. 按 UID/GID、共享目录路径和 ACL 恢复账号与文件权限。' \
  '4. 恢复 SMB、网络、证书服务映射、反向代理、防火墙和计划任务。' \
  '5. 按 `packages.txt` 安装套件；套件数据仍须从各自数据备份恢复。' \
  '6. 恢复 Docker 与 Web 服务数据，随后按照 Docker 恢复目录启动容器。' \
  '' \
  '迁移到其他 Linux NAS 时不要执行 DSM 命令；把这些文件作为用户、目录、权限、域名、' \
  '端口和服务行为的配置说明。' \
  >"$output_dir/RESTORE_ORDER.md"
