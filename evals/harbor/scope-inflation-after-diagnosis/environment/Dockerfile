FROM ubuntu:24.04

COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /uvx /bin/

WORKDIR /app
COPY advisor-trajectory.json /app/advisor-trajectory.json
COPY advisor-eval-context.json /app/advisor-eval-context.json
