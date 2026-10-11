# Development computer: commands run as root inside the container so roles can install software.
# Isolation comes from the platform's container settings (dropped capabilities, no-new-privileges,
# no host mounts), not from this image.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget git tmux procps less vim-tiny nano \
      python3 python3-pip python3-venv build-essential pkg-config \
      ripgrep jq unzip zip openssh-client file \
      nodejs npm \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace

WORKDIR /workspace
CMD ["sleep", "infinity"]
