# Secure Event Ticketing Platform

A containerised, multi-service event ticketing application delivered through a full
DevOps/DevSecOps pipeline: local development with Docker Compose, CI/CD with image scanning,
and production-style deployment on Kubernetes.

## Services

| Service | Tech | Port | Responsibility |
|---------|------|------|----------------|
| frontend | Node.js / Express | 3000 | Web UI + `/config` endpoint |
| api | Node.js / Express | 8080 | REST API: events, purchases, health/readiness |
| worker | Node.js | – | Consumes the order queue, writes to the database |
| postgres | PostgreSQL 16 | 5432 | Durable order storage |
| redis | Redis 7 | 6379 | Order queue / cache |

**Flow:** browser → frontend → (config) → browser → api → Redis (enqueue) → worker → Postgres.

## Documentation

- `docs/architecture.md` — design analysis (containers vs VM, service roles, communication, alignment).
- `docs/security/image-scan-report.md` — Trivy vulnerability scan results and remediation.
- `docs/runbook.md` — troubleshooting runbook for common incidents.

---

## Part 1 — Local development (Docker Compose)

### Prerequisites
- Docker Desktop (WSL2 backend on Windows)
- Git

### Run
```bash
# from the repo root
cp .env.example .env          # create local env file (do not commit it)
docker compose up --build     # starts all five services
```

The stack starts in dependency order (Postgres and Redis become healthy before api/worker/frontend start). Source folders are bind-mounted with hot-reload enabled for development.

### Validate
```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
curl http://localhost:8080/events
curl -X POST http://localhost:8080/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
curl http://localhost:8080/tickets/orders
```
A successful purchase appears in `/tickets/orders` with `"status":"processed"`, proving the
api → Redis → worker → Postgres chain. The UI is at **http://localhost:3000**.

### Shutdown
```bash
docker compose down       # stop, keep database volume
docker compose down -v    # stop and wipe database data
```

---

## CI/CD (GitHub Actions)

On every push/PR the pipeline (`.github/workflows/ci.yml`), per service:

1. installs dependencies (`npm ci`) and runs tests (`npm test`);
2. builds the container image;
3. **scans the image with Trivy** and fails the build on fixable HIGH/CRITICAL vulnerabilities (quality gate);
4. on `main`, after the scan passes, pushes the image to GitHub Container Registry, tagged with the commit SHA and `latest`.

Images: `ghcr.io/mmaric76/ticketing-{api,worker,frontend}`.

---

## Part 2 — Production deployment (Kubernetes)

### Prerequisites
- A Kubernetes cluster (this project uses minikube)
- `kubectl`
- The three images published to ghcr.io and set to **public** (or an image pull secret configured)

### Deploy
```bash
minikube start --driver=docker
minikube addons enable ingress

kubectl apply -f k8s/
kubectl get pods -n ticketing -w     # wait until all pods are Running / Ready
```

This creates: namespace, ConfigMap + Secret, ServiceAccount + Role/RoleBinding, Postgres
(Deployment + PVC) with the init schema, Redis, the api/worker/frontend Deployments with
liveness/readiness probes and resource limits, Services, an Ingress, and NetworkPolicies.

### Access the application

On the minikube **docker driver**, the cluster IP is not routable from the host, so reach the
app through a localhost tunnel:

```bash
# expose the ingress controller on localhost
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 18080:80
# add "127.0.0.1 ticketing.local" to the hosts file, then:
```
Browse to **http://ticketing.local:18080**, or test the API directly:
```bash
curl http://ticketing.local:18080/api/healthz
curl http://ticketing.local:18080/api/events
curl -X POST http://ticketing.local:18080/api/tickets/purchase \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1001","customerEmail":"student@example.com","quantity":2}'
curl http://ticketing.local:18080/api/tickets/orders
```

### Rolling update and rollback
```bash
kubectl rollout restart deployment/api -n ticketing   # trigger a rolling update
kubectl rollout status  deployment/api -n ticketing
kubectl rollout history deployment/api -n ticketing
kubectl rollout undo    deployment/api -n ticketing    # roll back to previous revision
kubectl rollout status  deployment/api -n ticketing
```

### Security controls in the cluster
- ConfigMap/Secret separation — no secrets hard-coded in images or source.
- Non-root containers, dropped capabilities, no privilege escalation.
- Dedicated ServiceAccount (token automount disabled) + minimal RBAC.
- NetworkPolicies limiting traffic to Postgres/Redis to the api and worker only.
- Trivy image scanning gate in CI before any image is published.

---

## Troubleshooting

See `docs/runbook.md` for diagnosis and recovery procedures for common incidents
(image pull errors, crash loops, database outages, ingress access on the docker driver, etc.).
