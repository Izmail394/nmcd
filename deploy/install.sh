#!/usr/bin/env bash
# Установка сервиса на чистый сервер Ubuntu 22.04 или 24.04 с правами root.
#   curl -fsSL https://raw.githubusercontent.com/Izmail394/nmcd/main/deploy/install.sh | bash
# Переменные (необязательно)
#   APP_DIR  каталог установки, по умолчанию /opt/nmcd
#   APP_PORT внешний порт, по умолчанию 80
#   NODE_IMAGE  образ Node.js, если Docker Hub недоступен, например mirror.gcr.io/library/node:24-alpine
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nmcd}"
APP_PORT="${APP_PORT:-80}"
REPO_URL="${REPO_URL:-https://github.com/Izmail394/nmcd.git}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите скрипт от имени root (sudo bash install.sh)." >&2
  exit 1
fi

echo "1/4 Установка Docker и Git"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io git curl
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker-compose-v2 || apt-get install -y docker-compose-plugin || apt-get install -y docker-compose
fi
systemctl enable --now docker

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi
}

echo "2/4 Загрузка кода в ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi
cd "${APP_DIR}"

echo "3/4 Настройка"
{
  echo "BIND=0.0.0.0"
  echo "PORT=${APP_PORT}"
  [ -n "${NODE_IMAGE:-}" ] && echo "NODE_IMAGE=${NODE_IMAGE}"
} > .env

echo "4/4 Сборка и запуск"
compose up -d --build

echo "Ожидание готовности"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
    IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
    echo "Готово. Сервис доступен по адресу http://${IP}:${APP_PORT}"
    exit 0
  fi
  sleep 3
done
echo "Сервис не ответил за 2 минуты. Журнал, команда compose logs --tail 80, в каталоге ${APP_DIR}" >&2
exit 1
