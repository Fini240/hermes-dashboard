# Stdlib-only dashboard: the image needs a Python and an ssh/scp client, and
# nothing else. No pip install, so no lockfile to drift.
FROM python:3.12-alpine

RUN apk add --no-cache openssh-client

WORKDIR /app
COPY hermes-dashboard-server.py /app/hermes-dashboard-server.py

# Unbuffered so `docker logs` shows the startup banner and any traceback
# immediately instead of holding them in a pipe buffer.
ENV PYTHONUNBUFFERED=1

EXPOSE 8765
ENTRYPOINT ["python3", "/app/hermes-dashboard-server.py"]
