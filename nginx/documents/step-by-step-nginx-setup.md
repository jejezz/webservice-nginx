# Step-by-step NGINX reverse proxy setup

Goal: run your face-recognition app on three local ports and place NGINX in front of them as an internal reverse proxy and load balancer.

## 1. Confirm the prerequisites

Make sure the following are available on the server:

- NGINX is installed
- `curl` is available
- Your app can run locally on a port
- You have a way to keep the app processes running (for example, separate terminals, `tmux`, `screen`, or `nohup`)

Install NGINX if needed:

```bash
sudo apt update
sudo apt install nginx
```

Check that NGINX is installed:

```bash
nginx -V
```

---

## 2. Start three app instances on separate ports

Use the same application binary or script three times, but bind each one to a different local port.

Suggested ports:

- 5501
- 5502
- 5503

Example pattern:

```bash
PORT=5501 your_app_start_command
```

```bash
PORT=5502 your_app_start_command
```

```bash
PORT=5503 your_app_start_command
```

If your app is launched with a flag instead of an environment variable, use the equivalent form:

```bash
python app.py --port 5501
python app.py --port 5502
python app.py --port 5503
```

Keep each process running in its own terminal, or detach them with `nohup`, `tmux`, or `screen`.

---

## 3. Verify each instance is responding

Test each app directly before putting NGINX in front of it.

```bash
curl http://127.0.0.1:5501/health
curl http://127.0.0.1:5502/health
curl http://127.0.0.1:5503/health
```

If your app does not expose `/health`, replace that path with a known working route such as `/`.

---

## 4. Create the NGINX configuration

Create a config file for the upstream and the server block.

```bash
sudo tee /etc/nginx/conf.d/face_backend.conf > /dev/null <<'EOF'
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
EOF
```

This config does the following:

- defines an upstream named `face_backend`
- load balances across the three app instances
- listens on port `8080`
- forwards requests to the app pool

---

## 5. Validate the NGINX configuration

Before reloading NGINX, check the syntax of the config:

```bash
sudo nginx -t
```

If the test succeeds, continue.

---

## 6. Reload NGINX

Apply the new configuration:

```bash
sudo systemctl reload nginx
```

If `systemctl` is not available or does not work in your environment, use:

```bash
sudo nginx -s reload
```

---

## 7. Test the proxy endpoint

Send a request through NGINX:

```bash
curl -i http://127.0.0.1:8080/
```

You should receive a response from one of the app instances.

If you receive a `502 Bad Gateway`, one of the upstream app instances is likely down. Check the app process and test each direct port again.

---

## 8. Confirm the routing works under repeated requests

Make several requests to confirm traffic is flowing through the proxy:

```bash
for i in $(seq 1 10); do curl -s http://127.0.0.1:8080/ >/dev/null; done
```

Then check whether the instances are being hit in a balanced way if your app logs request IDs or connection information.

---

## 9. Run a simple load test

Use a lightweight load test to observe behavior under concurrency.

If `ab` is available:

```bash
ab -n 20 -c 4 http://127.0.0.1:8080/
```

If not, install it:

```bash
sudo apt install apache2-utils
```

If you have `hey` installed, you can also use:

```bash
hey -n 50 -c 4 http://127.0.0.1:8080/
```

Replace `/` with the endpoint you actually want to test if your app uses a specific route.

---

## 10. Capture memory and latency information

While the load test runs, collect the following data:

```bash
free -h
```

If you are using GPU-based inference, also inspect GPU usage:

```bash
nvidia-smi
```

Record:

- memory usage with all three instances running
- latency observed during the load test
- any timeouts or failures

These observations will help you validate whether the current setup is stable enough for the expected traffic.

---

## 11. Common troubleshooting steps

### NGINX fails to start

Check the config syntax:

```bash
sudo nginx -t
```

### Port 8080 is already in use

Find the process using the port:

```bash
sudo ss -ltnp | grep 8080
```

### `502 Bad Gateway`

This usually means an upstream app instance is down or not responding. Check each direct port:

```bash
curl http://127.0.0.1:5501/health
curl http://127.0.0.1:5502/health
curl http://127.0.0.1:5503/health
```

### `504 Gateway Timeout`

This can happen when inference jobs take a long time. Increase the timeout values in the config if necessary:

```nginx
proxy_send_timeout 120s;
proxy_read_timeout 120s;
```

---

## 12. Suggested next step

Once this works, you can expand the setup by adding more upstream targets or tuning the timeout and keepalive settings for production-like traffic.
