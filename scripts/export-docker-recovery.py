#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
from typing import Any

import yaml


PATH_VARIABLES = (
    ("/volume1/docker", "DOCKER_ROOT"),
    ("/volume1/web", "WEB_ROOT"),
    ("/volume1/movie", "MEDIA_ROOT"),
    ("/volume1/Downloads", "DOWNLOADS_ROOT"),
    ("/volume2/TimeMachine", "TIMEMACHINE_ROOT"),
    ("/usr/syno/etc/certificate", "DSM_CERTIFICATE_ROOT"),
)


def run_json(arguments: list[str]) -> Any:
    return json.loads(subprocess.check_output(arguments, text=True))


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "unnamed"


def portable_path(source: str) -> str:
    for root, variable in PATH_VARIABLES:
        if source == root:
            return f"${{{variable}:-{root}}}"
        if source.startswith(root + "/"):
            return f"${{{variable}:-{root}}}{source[len(root):]}"
    return source


def duration(nanoseconds: int | None) -> str | None:
    if not nanoseconds:
        return None
    if nanoseconds % 1_000_000_000 == 0:
        return f"{nanoseconds // 1_000_000_000}s"
    if nanoseconds % 1_000_000 == 0:
        return f"{nanoseconds // 1_000_000}ms"
    return f"{nanoseconds}ns"


def add_if(service: dict[str, Any], key: str, value: Any, default: Any = None) -> None:
    if value is not None and value != default and value != [] and value != {} and value != "":
        service[key] = value


def literal(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [literal(item) for item in value]
    if isinstance(value, dict):
        return {key: literal(item) for key, item in value.items()}
    return value


def mount_string(mount: dict[str, Any], volume_names: set[str]) -> str | None:
    destination = mount["Destination"]
    suffix = ":ro" if not mount.get("RW", True) else ""
    if mount["Type"] == "bind":
        return f"{portable_path(mount['Source'])}:{destination}{suffix}"
    if mount["Type"] == "volume":
        name = mount.get("Name") or pathlib.Path(mount["Source"]).parent.name
        volume_names.add(name)
        return f"{name}:{destination}{suffix}"
    return None


def port_strings(bindings: dict[str, Any] | None) -> list[str]:
    ports: list[str] = []
    for container_port, host_bindings in sorted((bindings or {}).items()):
        for binding in host_bindings or []:
            host_ip = binding.get("HostIp", "")
            host_port = binding.get("HostPort", "")
            prefix = f"{host_ip}:" if host_ip not in ("", "0.0.0.0", "::") else ""
            value = f"{prefix}{host_port}:{container_port}"
            if value not in ports:
                ports.append(value)
    return ports


def healthcheck(config: dict[str, Any] | None) -> dict[str, Any] | None:
    if not config:
        return None
    result: dict[str, Any] = {"test": literal(config.get("Test", []))}
    for source, target in (
        ("Interval", "interval"),
        ("Timeout", "timeout"),
        ("StartPeriod", "start_period"),
    ):
        value = duration(config.get(source))
        if value:
            result[target] = value
    if config.get("Retries"):
        result["retries"] = config["Retries"]
    return result


def container_service(
    container: dict[str, Any], volume_names: set[str], network_names: set[str]
) -> dict[str, Any]:
    config = container["Config"]
    host = container["HostConfig"]
    service: dict[str, Any] = {
        "container_name": container["Name"].lstrip("/"),
        "image": config["Image"],
    }
    add_if(service, "command", literal(config.get("Cmd")))
    add_if(service, "entrypoint", literal(config.get("Entrypoint")))
    add_if(service, "environment", literal(config.get("Env")))
    add_if(service, "user", config.get("User"))
    add_if(service, "working_dir", config.get("WorkingDir"))
    if config.get("Hostname") and config["Hostname"] != container["Id"][:12]:
        service["hostname"] = config["Hostname"]
    add_if(service, "healthcheck", healthcheck(config.get("Healthcheck")))
    add_if(service, "stop_signal", config.get("StopSignal"))
    add_if(service, "stdin_open", config.get("OpenStdin"), False)
    add_if(service, "tty", config.get("Tty"), False)

    restart_name = (host.get("RestartPolicy") or {}).get("Name")
    add_if(service, "restart", restart_name, "no")
    add_if(service, "privileged", host.get("Privileged"), False)
    add_if(service, "read_only", host.get("ReadonlyRootfs"), False)
    add_if(service, "init", host.get("Init"), False)
    add_if(service, "cap_add", host.get("CapAdd"))
    add_if(service, "cap_drop", host.get("CapDrop"))
    add_if(service, "group_add", host.get("GroupAdd"))
    add_if(service, "dns", host.get("Dns"))
    add_if(service, "dns_search", host.get("DnsSearch"))
    add_if(service, "extra_hosts", host.get("ExtraHosts"))
    add_if(service, "security_opt", host.get("SecurityOpt"))
    add_if(service, "sysctls", host.get("Sysctls"))
    add_if(service, "shm_size", host.get("ShmSize"), 67_108_864)

    if host.get("Memory", 0) > 0:
        service["mem_limit"] = host["Memory"]
    if host.get("NanoCpus", 0) > 0:
        service["cpus"] = host["NanoCpus"] / 1_000_000_000

    ports = port_strings(host.get("PortBindings"))
    add_if(service, "ports", ports)

    mounts = [mount_string(item, volume_names) for item in container.get("Mounts", [])]
    add_if(service, "volumes", [item for item in mounts if item])
    add_if(
        service,
        "devices",
        [
            f"{item['PathOnHost']}:{item['PathInContainer']}:{item['CgroupPermissions']}"
            for item in host.get("Devices") or []
        ],
    )

    log_config = host.get("LogConfig") or {}
    if log_config.get("Type") and log_config["Type"] != "json-file":
        service["logging"] = {
            "driver": log_config["Type"],
            "options": log_config.get("Config") or {},
        }

    compose_labels = {
        key: value
        for key, value in (config.get("Labels") or {}).items()
        if not key.startswith("com.docker.compose.")
    }
    add_if(service, "labels", literal(compose_labels))

    network_mode = host.get("NetworkMode") or "default"
    endpoint_names = sorted((container.get("NetworkSettings", {}).get("Networks") or {}).keys())
    if network_mode in ("host", "none", "bridge"):
        service["network_mode"] = network_mode
    elif endpoint_names:
        service["networks"] = endpoint_names
        network_names.update(endpoint_names)
    return service


def compose_document(containers: list[dict[str, Any]]) -> dict[str, Any]:
    volume_names: set[str] = set()
    network_names: set[str] = set()
    services = {
        safe_name(container["Name"].lstrip("/")): container_service(
            container, volume_names, network_names
        )
        for container in sorted(containers, key=lambda item: item["Name"])
    }
    document: dict[str, Any] = {"name": "nas-recovery", "services": services}
    if volume_names:
        document["volumes"] = {name: {"name": name} for name in sorted(volume_names)}
    if network_names:
        document["networks"] = {
            name: {"name": name, "external": True} for name in sorted(network_names)
        }
    return document


def project_exports(containers: list[dict[str, Any]], output_dir: pathlib.Path) -> list[dict[str, Any]]:
    projects: dict[str, dict[str, Any]] = {}
    for container in containers:
        labels = container["Config"].get("Labels") or {}
        project = labels.get("com.docker.compose.project")
        if not project:
            continue
        entry = projects.setdefault(
            project,
            {
                "project": project,
                "working_dir": labels.get("com.docker.compose.project.working_dir"),
                "config_files": labels.get("com.docker.compose.project.config_files", "").split(","),
                "containers": [],
            },
        )
        entry["containers"].append(container["Name"].lstrip("/"))

    records: list[dict[str, Any]] = []
    for project, entry in sorted(projects.items()):
        project_dir = output_dir / safe_name(project)
        project_dir.mkdir(parents=True)
        files = [item for item in entry["config_files"] if item]
        for index, source_name in enumerate(files, start=1):
            source = pathlib.Path(source_name)
            if source.is_file():
                shutil.copy2(source, project_dir / f"source-{index}-{source.name}")

        command = ["docker", "compose"]
        working_dir = entry.get("working_dir")
        if working_dir:
            command.extend(["--project-directory", working_dir])
        for source_name in files:
            command.extend(["-f", source_name])
        command.append("config")
        try:
            result = subprocess.run(
                command,
                cwd=working_dir if working_dir and os.path.isdir(working_dir) else None,
                text=True,
                capture_output=True,
                check=True,
            )
            (project_dir / "compose.rendered.yaml").write_text(result.stdout, encoding="utf-8")
            entry["render_status"] = "ok"
        except subprocess.CalledProcessError as exc:
            (project_dir / "compose.render-error.txt").write_text(
                exc.stdout + "\n" + exc.stderr, encoding="utf-8"
            )
            entry["render_status"] = "failed"
        (project_dir / "project.json").write_text(
            json.dumps(entry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        records.append(entry)
    return records


def write_yaml(path: pathlib.Path, value: Any) -> None:
    path.write_text(
        yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=120),
        encoding="utf-8",
    )


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} OUTPUT_DIRECTORY", file=sys.stderr)
        return 2
    output_dir = pathlib.Path(sys.argv[1])
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "raw").mkdir()
    (output_dir / "projects").mkdir()

    container_ids = subprocess.check_output(["docker", "ps", "-aq"], text=True).split()
    containers = run_json(["docker", "inspect", *container_ids]) if container_ids else []
    json_dump = lambda value: json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    (output_dir / "raw" / "containers.json").write_text(json_dump(containers), encoding="utf-8")

    image_ids = subprocess.check_output(["docker", "image", "ls", "-q"], text=True).split()
    images = run_json(["docker", "image", "inspect", *sorted(set(image_ids))]) if image_ids else []
    image_summary = [
        {
            "id": image["Id"],
            "repo_tags": image.get("RepoTags") or [],
            "repo_digests": image.get("RepoDigests") or [],
            "created": image.get("Created"),
            "architecture": image.get("Architecture"),
            "os": image.get("Os"),
        }
        for image in images
    ]
    (output_dir / "raw" / "images.json").write_text(json_dump(image_summary), encoding="utf-8")

    network_ids = subprocess.check_output(["docker", "network", "ls", "-q"], text=True).split()
    networks = run_json(["docker", "network", "inspect", *network_ids]) if network_ids else []
    (output_dir / "raw" / "networks.json").write_text(json_dump(networks), encoding="utf-8")

    volume_names = subprocess.check_output(["docker", "volume", "ls", "-q"], text=True).split()
    volumes = run_json(["docker", "volume", "inspect", *volume_names]) if volume_names else []
    (output_dir / "raw" / "volumes.json").write_text(json_dump(volumes), encoding="utf-8")

    all_compose = compose_document(containers)
    write_yaml(output_dir / "compose.all.generated.yaml", all_compose)
    standalone = [
        container
        for container in containers
        if not (container["Config"].get("Labels") or {}).get("com.docker.compose.project")
    ]
    write_yaml(output_dir / "compose.standalone.generated.yaml", compose_document(standalone))
    projects = project_exports(containers, output_dir / "projects")

    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "docker_version": subprocess.check_output(
            ["docker", "version", "--format", "{{json .}}"], text=True
        ).strip(),
        "container_count": len(containers),
        "compose_project_count": len(projects),
        "standalone_container_count": len(standalone),
        "path_variables": {variable: root for root, variable in PATH_VARIABLES},
        "named_volumes": [volume["Name"] for volume in volumes],
        "used_named_volumes": sorted(
            {
                mount["Name"]
                for container in containers
                for mount in container.get("Mounts", [])
                if mount.get("Type") == "volume" and mount.get("Name")
            }
        ),
        "named_volume_backup_map": {
            "autofilm-core_telegram-data": "/source/docker-volumes/telegram-data",
            "backrest_backrest-webui-node-modules": "omitted: development dependency cache",
            "backrest_backrest-webui-pnpm-store": "omitted: development package cache",
        },
        "projects": projects,
    }
    (output_dir / "manifest.json").write_text(json_dump(manifest), encoding="utf-8")

    shutil.copy2("/volume1/docker/autofilm-suite/autofilm-core/.env.full.example", output_dir / ".env.recovery.example")
    with (output_dir / ".env.recovery.example").open("a", encoding="utf-8") as handle:
        handle.write("\n# Cross-NAS source roots used by generated Compose files\n")
        for root, variable in PATH_VARIABLES:
            handle.write(f"{variable}={root}\n")

    (output_dir / "RESTORE.md").write_text(
        """# Docker 恢复顺序

1. 恢复 `/source/docker`、Web 服务目录、命名卷数据和 `/staging/recovery`。
2. 修改 `.env.recovery.example` 中的根目录，使其符合目标 NAS。
3. 优先使用 `projects/*/compose.rendered.yaml` 恢复原 Compose 项目。
4. 使用 `compose.standalone.generated.yaml` 恢复原本没有 Compose 文件的容器。
5. `compose.all.generated.yaml` 是全部容器的运行时快照，适合核对端口、环境变量、挂载和启动策略。
6. 按 `raw/volumes.json` 恢复命名卷数据，按 `raw/networks.json` 创建外部网络。
7. 数据库文件使用相邻的 `databases` 目录中的一致性副本，不使用在线数据库原文件。

生成的 Compose 含运行时环境变量，属于加密灾备资料。跨系统恢复时需要调整 UID/GID、
路径、证书目录和仅 DSM 存在的挂载。
""",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
