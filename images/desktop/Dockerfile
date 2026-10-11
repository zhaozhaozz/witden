# Desktop computer: Xvfb + Fluxbox + Chromium, driven with xdotool and observed over VNC.
# Two VNC servers listen on localhost only: 5900 (control) and 5901 (view-only). The platform
# reaches them through `docker exec` (no published ports), so the desktop is never exposed directly.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 DISPLAY=:1 TERM=xterm-256color

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox xterm xdotool imagemagick x11-utils dbus-x11 \
      chromium fonts-noto-cjk fonts-dejavu-core \
      supervisor socat tmux procps ca-certificates curl git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -u 1000 witden \
 && echo 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-dev-shm-usage --no-first-run"' \
      > /etc/chromium.d/witden-container

COPY supervisord.conf /etc/supervisor/conf.d/witden.conf
COPY fluxbox-startup /home/witden/.fluxbox/startup
# Plain background: the default style tries to set a wallpaper and pops up an error dialog without one,
# which would confuse a role reading the screen.
COPY fluxbox-overlay /home/witden/.fluxbox/overlay
# fbsetbg cannot set the style's wallpaper in this minimal image and would pop up an error dialog; use a solid colour.
RUN chown -R witden:witden /home/witden/.fluxbox && chmod +x /home/witden/.fluxbox/startup \
 && printf '#!/bin/sh\nexec fbsetroot -solid "#2f3b45"\n' > /usr/bin/fbsetbg

WORKDIR /home/witden
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
