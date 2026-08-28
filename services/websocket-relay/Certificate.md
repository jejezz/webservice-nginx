# HOW TO CREATE SELF-SIGNED CA CERTIFICATES
 - "*******" = password


---


## Step 1: Create the Root CA Certificate

The Root CA is the ultimate source of trust. Its certificate is "self-signed," meaning its public key is used to verify its own digital signature. You should treat this key with extreme care. It should be kept offline in a secure location and used only to sign Intermediate CA certificates.

### 1. Create a private key for the Root CA:

```bash
openssl genrsa -aes256 -out ./src/certs/root-ca.key 4096

## output
Generating RSA private key, 4096 bit long modulus (2 primes)
.......................................................................++++
........................................................................................................................................................................................................................................++++
e is 65537 (0x010001)
Enter pass phrase for root-ca.key: *******
Verifying - Enter pass phrase for root-ca.key: *******
````

- genrsa: Generates a new RSA private key.
- aes256: Encrypts the key with AES-256 for security. You will be prompted to enter a passphrase.
- out root-ca.key: Specifies the output file for the private key.
- 4096: Sets the key size to 4096 bits, which is a strong recommendation.

### 2. Create a self-signed Root CA certificate:

```bash
openssl req -x509 -new -nodes -key ./src/certs/root/root-ca.key -sha256 \
    -days 3650 -out ./src/certs/root/root-ca.crt

## output
Enter pass phrase for ./src/certs/root/root-ca.key: *******
You are about to be asked to enter information that will be incorporated
into your certificate request.
What you are about to enter is what is called a Distinguished Name or a DN.
There are quite a few fields but you can leave some blank
For some fields there will be a default value,
If you enter '.', the field will be left blank.
-----
Country Name (2 letter code) [AU]:KR
State or Province Name (full name) [Some-State]:Seoul
Locality Name (eg, city) []:Seoul
Organization Name (eg, company) [Internet Widgits Pty Ltd]:PTYPE Root CA
Organizational Unit Name (eg, section) []:software
Common Name (e.g. server FQDN or YOUR name) []:ptype.co.kr
Email Address []:jyahn@ptype.co.kr
```
- req: Creates a certificate signing request (CSR).
- -x509: This is crucial. It tells OpenSSL to create a self-signed certificate instead of a CSR. This makes it a CA certificate.
- -new: Creates a new certificate.
- -nodes: No DES encryption for the private key (you already encrypted it in the previous step).
- -key root-ca.key: Uses the private key you just created.
- -sha256: Uses the SHA-256 hash algorithm for the signature.
- -days 3650: Sets the validity period to 10 years (365 days * 10 years). Root CA certificates should have a long lifespan.
- -out root-ca.crt: Specifies the output file for the certificate.

You will be prompted to enter information like Country Name, State, Organization Name, etc. For the Common Name (CN), you should use something descriptive like "My Company Root CA".


## Step 2: Create the Intermediate CA Certificate

The Intermediate CA is used to sign server certificates. This is a best practice because it allows you to keep the Root CA offline and minimizes the damage if the Intermediate CA's key is compromised.

### 1. Create a private key for the Intermediate CA:

```bash
openssl genrsa -aes256 -out ./src/certs/intermediate-ca.key 4096

## output
Generating RSA private key, 4096 bit long modulus (2 primes)
...++++
.................................................................................................................................................++++
e is 65537 (0x010001)
Enter pass phrase for ./src/certs/intermediate-ca.key:
Verifying - Enter pass phrase for ./src/certs/intermediate-ca.key:
```
- This is similar to creating the Root CA key.

### 2. Create a self-signed Intermediate CA certificate:


```bash
openssl req -new -key ./src/certs/intermediate-ca.key -sha256 -out ./src/certs/intermediate-ca.csr

## output
Enter pass phrase for ./src/certs/intermediate-ca.key:
You are about to be asked to enter information that will be incorporated
into your certificate request.
What you are about to enter is what is called a Distinguished Name or a DN.
There are quite a few fields but you can leave some blank
For some fields there will be a default value,
If you enter '.', the field will be left blank.
-----
Country Name (2 letter code) [AU]:KR
State or Province Name (full name) [Some-State]:Seoul
Locality Name (eg, city) []:Seoul
Organization Name (eg, company) [Internet Widgits Pty Ltd]:PTYPE intermediate CA 
Organizational Unit Name (eg, section) []:software
Common Name (e.g. server FQDN or YOUR name) []:ptype.co.kr
Email Address []:jyahn@ptype.co.kr

Please enter the following 'extra' attributes
to be sent with your certificate request
A challenge password []:       
An optional company name []:
```
- This time, we are creating a CSR (-new) and not a self-signed certificate (-x509 is omitted).
- For the Common Name (CN), use something like "My Company Intermediate CA".

### 3. Sign the Intermediate CA CSR with the Root CA:

```bash
openssl x509 -req -in ./src/certs/intermediate-ca.csr \
 -CA ./src/certs/root/root-ca.crt -CAkey ./src/certs/root/root-ca.key \
 -CAcreateserial -out ./src/certs/intermediate-ca.crt -days 1825 -sha256 \
 -extfile <(printf "basicConstraints=CA:TRUE,pathlen:0")

## output
Signature ok
subject=C = KR, ST = Seoul, L = Seoul, O = PTYPE intermediate CA, OU = software, CN = callfusion.ptype.co.kr, emailAddress = jyahn@ptype.co.kr
Getting CA Private Key
Enter pass phrase for ./src/certs/root/root-ca.key *******
```

- x509: Again, we are dealing with X.509 certificates.
- -req: Specifies that the input is a CSR.
- -in intermediate-ca.csr: The CSR from the previous step.
- -CA root-ca.crt: Specifies the Root CA certificate to sign with.
- -CAkey root-ca.key: Specifies the Root CA's private key.
- -CAcreateserial: Creates a serial number file.
- -out intermediate-ca.crt: The output file for the signed Intermediate CA certificate.
- -days 1825: Sets a shorter validity period (e.g., 5 years).
- -extfile <(printf "basicConstraints=CA:TRUE,pathlen:0"): This is a critical step. It adds the basicConstraints extension to the certificate, marking it as a CA that can sign other certificates. pathlen:0 specifies that this CA can only sign end-entity (server/client) certificates, not other CAs.


## Step 3: Create the Server Certificate

Now you can use your Intermediate CA to issue a certificate for your web server.

### 1. Create a private key for the server:

```bash
openssl genrsa -out ./src/certs/server.key 2048

## output
Generating RSA private key, 2048 bit long modulus (2 primes)
...+++++
........................+++++
e is 65537 (0x010001)
```
- This key should be unique to the server. You can use 2048 or 4096 bits.

### 2. Create a CSR for the server:

```bash
openssl req -new -key ./src/certs/server.key -sha256 -out ./src/certs/server.csr -config ./src/certs/server_csr.conf
```

- Important: For the Common Name (CN), you must use the domain name of your server (e.g., www.example.com). This is what the browser will check during the handshake. You can also add Subject Alternative Names (SANs) in a configuration file for multiple domain names.
- Check ./src/certs/server_csr.conf file

### 3. Sign the server CSR with the Intermediate CA:

```bash
openssl x509 -req -in ./src/certs/server.csr \
    -CA ./src/certs/intermediate-ca.crt \
    -CAkey ./src/certs/intermediate-ca.key \
    -CAcreateserial \
    -out ./src/certs/server.crt \
    -days 365 \
    -sha256 \
    -extfile ./src/certs/v3.ext \
    -extensions v3_req

##output
Signature ok
subject=C = KR, ST = Gyeonggi-do, L = Anyang-si, O = PTYPE, OU = SOFTWARE, CN = callfusion.ptype.co.kr, emailAddress = jyahn@ptype.co.kr
Getting CA Private Key
Enter pass phrase for ./src/certs/intermediate-ca.key: *******
```
- Check ./src/certs/v3.ext file
- This command is similar to signing the Intermediate CA, but this time we use the Intermediate CA's key and certificate to sign the server's CSR.
- The validity period (-days) should be shorter, typically 1 year.
- now check if the certificate is generated correctly

```
openssl x509 -in ./src/certs/server.crt -text -noout

## output
        Validity
            Not Before: Jun 28 01:13:40 2025 GMT
            Not After : Jun 28 01:13:40 2026 GMT
        Subject: C = KR, ST = Gyeonggi-do, L = Anyang-si, O = PTYPE, OU = SOFTWARE, CN = callfusion.ptype.co.kr, emailAddress = jyahn@ptype.co.kr
        
        ....

        X509v3 extensions:
            X509v3 Authority Key Identifier: 
                DirName:/C=KR/ST=Seoul/L=Seoul/O=PTYPE Root CA/OU=software/CN=ptype.co.kr/emailAddress=jyahn@ptype.co.kr
                serial:3C:0D:D4:47:EF:3B:73:66:8D:30:60:78:3C:0F:C5:0D:5A:7A:B4:B0

            X509v3 Basic Constraints: 
                CA:FALSE
            X509v3 Key Usage: 
                Digital Signature, Non Repudiation, Key Encipherment, Data Encipherment
            X509v3 Subject Alternative Name: 
                DNS:callfusion.ptype.co.kr, DNS:dev.ptype.co.kr, IP Address:10.10.0.225
```


## Step 4: Install the Root CA Certificate on the Android Device


## Step 5: Modify your HTTPS:

```JavaScript
const https = require('https');
const fs = require('fs');

const privateKey = fs.readFileSync('server.key', 'utf8'); // Load the private key
const certificate = fs.readFileSync('server.crt', 'utf8'); // Load the certificate
const ca = fs.readFileSync('intermediate-ca.crt', 'utf8'); // Load the intermediate CA certificate

const credentials = {
  key: privateKey,
  cert: certificate,
  ca: ca // Include the intermediate CA
};

const server = https.createServer(credentials, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, HTTPS!');
});

const port = 3001; // Use a different port for HTTPS (e.g., 3001)
server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

## Step 6: Renew the Certificates and Test

For renewal, you do not need to touch your Root CA or Intermediate CA. Their keys and certificates are designed to be long-lived and should only be used to sign other certificates.

You only need to repeat the steps involved in creating the server certificate.

Here are the specific steps you should repeat to renew your callfusion.ptype.co.kr server certificate.

### 1. Generate a New Private Key (Recommended)

While you could re-use your existing server.key, it is a security best practice to generate a new, unique private key every time you renew a certificate. This ensures Forward Secrecy and limits the damage if a key is ever compromised.

```bash
# Generate a new 2048-bit RSA private key for the renewed certificate
openssl genrsa -out ./src/certs/server.key 2048

## output
Generating RSA private key, 2048 bit long modulus (2 primes)
........................+++++
.......................+++++
e is 65537 (0x010001)
```

*You will be prompted for a passphrase if you added -aes256 in your previous command. For a server, you typically do not encrypt the key to avoid needing a password on startup.*

### 2. Generate a New CSR

Now, you will use your new private key to create a new Certificate Signing Request (CSR). You can re-use the configuration file you fixed previously (server_csr.conf).

```bash
# Create a new CSR using the configuration file
openssl req -new -key ./src/certs/server.key -sha256 -out ./src/certs/new_server.csr -config ./src/certs/server_csr.conf
```

### 3. Sign the CSR with Your Intermediate CA

This is the key step where you "renew" the certificate by signing the new CSR. You will use your Intermediate CA's key and certificate for this. Make sure to use the exact v3.ext file that we fixed to include the SAN.

```bash
# Sign the new CSR with the Intermediate CA to create the renewed certificate
openssl x509 -req -in ./src/certs/new_server.csr \
    -CA ./src/certs/intermediate-ca.crt \
    -CAkey ./src/certs/intermediate-ca.key \
    -CAcreateserial \
    -out ./src/certs/renewed_server.crt \
    -days 365 \
    -sha256 \
    -extfile ./src/certs/v3.ext \
    -extensions v3_req

##output
Signature ok
subject=C = KR, ST = Gyeonggi-do, L = Anyang-si, O = PTYPE, OU = SOFTWARE, CN = callfusion.ptype.co.kr, emailAddress = jyahn@ptype.co.kr
Getting CA Private Key
Enter pass phrase for ./src/certs/intermediate-ca.key:    
```

### 4. # Verify the contents of the renewed certificate

Always verify the contents of the new certificate before deploying it.

```bash
openssl x509 -in ./src/certs/renewed_server.crt -text -noout

##output
Validity
            Not Before: Jun 28 01:28:37 2025 GMT
            Not After : Jun 28 01:28:37 2026 GMT
        Subject: C = KR, ST = Gyeonggi-do, L = Anyang-si, O = PTYPE, OU = SOFTWARE, CN = callfusion.ptype.co.kr, emailAddress = jyahn@ptype.co.kr
....

X509v3 extensions:
            X509v3 Authority Key Identifier: 
                DirName:/C=KR/ST=Seoul/L=Seoul/O=PTYPE Root CA/OU=software/CN=ptype.co.kr/emailAddress=jyahn@ptype.co.kr
                serial:3C:0D:D4:47:EF:3B:73:66:8D:30:60:78:3C:0F:C5:0D:5A:7A:B4:B0

            X509v3 Basic Constraints: 
                CA:FALSE
            X509v3 Key Usage: 
                Digital Signature, Non Repudiation, Key Encipherment, Data Encipherment
            X509v3 Subject Alternative Name: 
                DNS:callfusion.ptype.co.kr, DNS:dev.ptype.co.kr, IP Address:10.10.0.225
    Signature Algorithm: sha256WithRSAEncryption
```

### 5. Install the New Certificate on Your Node.js Server

Finally, replace the old server.crt file with the new renewed_server.crt on your server. You will also use the new server.key you generated in Step 1.

Update your Node.js code to point to the new files:

```Javascript

const privateKey = fs.readFileSync('server.key', 'utf8'); // Use the new key
const certificate = fs.readFileSync('renewed_server.crt', 'utf8'); // Use the renewed certificate
const ca = fs.readFileSync('intermediate-ca.crt', 'utf8'); // This file does not change

```