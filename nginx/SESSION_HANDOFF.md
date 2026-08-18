# Session Handoff

Date: 2026-08-03

## Current Goal
Set up NGINX as an internal reverse proxy/load balancer in front of face-recognition app instances.

## Confirmed Architecture Direction
1. Use NGINX as internal proxy/load balancer.
2. Run multiple app instances, each with 1 worker, on different internal ports.
3. Scale later by attaching more instances/hosts behind NGINX.

## Capacity Assumption Confirmed
You observed current server can run 3 workers without memory shortage.

Working assumption for next step:
- 3 app instances x 1 worker each should be feasible from a memory perspective.
- Suggested initial ports: 5501, 5502, 5503.

## Why This Layout
- Better failure isolation per instance.
- Cleaner health-based traffic routing from NGINX.
- Easy incremental scale-out by adding upstream targets.

## Items To Validate During Rollout
1. Peak memory/VRAM headroom with all 3 instances active.
2. p95/p99 latency under load.
3. NGINX upstream timeout and keepalive behavior for long inference calls.
4. Health endpoint reliability for instance readiness.

## Minimal NGINX Starter Template
Use this as a starting point in your next step:

```nginx
upstream face_backend {
    least_conn;
    server 127.0.0.1:5501 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:5502 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:5503 max_fails=3 fail_timeout=10s;

    keepalive 32;
}

server {
    listen 8080;
    server_name _;

    location / {
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 5s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;

        proxy_pass http://face_backend;
    }
}
```

## Suggested First Commands In New Session
1. Create nginx.conf with upstream + server block.
2. Start 3 app instances on 5501/5502/5503.
3. Curl test through NGINX endpoint.
4. Run short load test and capture latency + memory.
