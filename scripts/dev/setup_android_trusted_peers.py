import subprocess
import os
import sqlite3
import tempfile
import time

ADB = r"C:\Users\31752\android-dev\android-sdk\platform-tools\adb.exe"

PEERS = [
    {
        'deviceId': '99add766887178ba',
        'displayName': 'node-ubuntu',
        'fingerprint': '99AD-D766-8871-78BA-8AF7-5DAC',
        'signingPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAvDZnRhwakc0b8EGYxQynWINo/WcHfh7Mbbo/n7TI0zA=\n-----END PUBLIC KEY-----\n',
        'encryptionPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAcGdyjRREYSUYez65YeNfg93z1uinfIadrxqwm7kphSM=\n-----END PUBLIC KEY-----\n'
    },
    {
        'deviceId': '6b6ef88d104e9817',
        'displayName': 'node-centos',
        'fingerprint': '6B6E-F88D-104E-9817-12C6-08E2',
        'signingPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAstUdh1ILeRLwF6ngXUQerziVOMH9E4weq89wpomSAk0=\n-----END PUBLIC KEY-----\n',
        'encryptionPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAVw4bH3vXF4EgkgRuilFxT2bR3I7RW1QrCCkNmcBJXWU=\n-----END PUBLIC KEY-----\n'
    },
    {
        'deviceId': '4c985ef50c313c09',
        'displayName': 'node-winvm',
        'fingerprint': '4C98-5EF5-0C31-3C09-DD9D-8D4D',
        'signingPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6hub+PPuT8aJ7hpcO6KEOJ3xvmnDCSfkGlx/Ilb4Bm4=\n-----END PUBLIC KEY-----\n',
        'encryptionPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAkbG3Y80YvWJr/inHM94IvZGWDw8OraZdpyERIfyDyDg=\n-----END PUBLIC KEY-----\n'
    },
    {
        'deviceId': 'e23c38b8389afb57',
        'displayName': 'Redmi K50',
        'fingerprint': 'E23C-38B8-389A-FB57-BBA3-BED6',
        'signingPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAl7q3TLbch3XFodrIRmUlecja3dLWwhMMHgBRDLTZtjM=\n-----END PUBLIC KEY-----\n',
        'encryptionPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEABiy8WVaEC649l4vFjs512DcAtXA4v2evXqM3x3ipLRM=\n-----END PUBLIC KEY-----\n'
    },
    {
        'deviceId': '22560b305ba893c3',
        'displayName': 'Samsung S10+',
        'fingerprint': '2256-0B30-5BA8-93C3-EDE7-4653',
        'signingPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA43BrJVebQhLukrKS8NulqroQ0euHTLrMNEDw+yJFADI=\n-----END PUBLIC KEY-----\n',
        'encryptionPublicKey': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAPbUpReaS4Wy2Is598QKmN0bdjFsVpYeeomzEH/Jvu1Y=\n-----END PUBLIC KEY-----\n'
    }
]

def populate_trusted_peers():
    for dev_serial in ['9LLBPRVWHQHQUSS4', 'R58M4308MGE']:
        print(f"[*] Stream updating DB for {dev_serial}...")
        subprocess.run([ADB, '-s', dev_serial, 'shell', 'am', 'force-stop', 'io.github.nearbytransfer.android'], capture_output=True)
        time.sleep(0.3)

        with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
            tmp_path = tmp.name

        proc_out = subprocess.Popen([ADB, '-s', dev_serial, 'exec-out', 'run-as io.github.nearbytransfer.android cat /data/data/io.github.nearbytransfer.android/databases/nearby-transfer-v2.db'], stdout=subprocess.PIPE)
        raw_db, _ = proc_out.communicate()
        with open(tmp_path, 'wb') as f:
            f.write(raw_db)

        conn = sqlite3.connect(tmp_path)
        cur = conn.cursor()

        for p in PEERS:
            cur.execute("""
                INSERT OR REPLACE INTO trusted_peers 
                (device_id, display_name, fingerprint, signing_public_key, encryption_public_key, permissions, trust_status, paired_at_epoch_millis, updated_at_epoch_millis) 
                VALUES (?, ?, ?, ?, ?, 'TRANSFER', 'TRUSTED', 1724832000000, 1724832000000)
            """, (p['deviceId'], p['displayName'], p['fingerprint'], p['signingPublicKey'], p['encryptionPublicKey']))
        
        conn.commit()

        cur.execute("SELECT device_id, display_name, trust_status FROM trusted_peers")
        rows = cur.fetchall()
        print(f"    Trusted peers in DB on {dev_serial}:")
        for r in rows:
            print(f"      - {r[1]} ({r[0]}): {r[2]}")
        conn.close()

        with open(tmp_path, 'rb') as f:
            modified_db = f.read()

        # Write back via exec-in / stdin
        proc_in = subprocess.Popen([ADB, '-s', dev_serial, 'exec-in', 'run-as io.github.nearbytransfer.android tee /data/data/io.github.nearbytransfer.android/databases/nearby-transfer-v2.db > /dev/null'], stdin=subprocess.PIPE)
        proc_in.communicate(input=modified_db)

        # Clear wal / shm files so the new DB file is loaded fresh
        subprocess.run([ADB, '-s', dev_serial, 'shell', 'run-as io.github.nearbytransfer.android rm -f /data/data/io.github.nearbytransfer.android/databases/nearby-transfer-v2.db-wal /data/data/io.github.nearbytransfer.android/databases/nearby-transfer-v2.db-shm'], capture_output=True)

        try:
            os.remove(tmp_path)
        except:
            pass

        # Restart app
        subprocess.run([ADB, '-s', dev_serial, 'shell', 'am', 'start', '-n', 'io.github.nearbytransfer.android/.MainActivity'], capture_output=True)
        print(f"    [+] Successfully updated trusted peers & restarted app on {dev_serial}!\n")

if __name__ == '__main__':
    populate_trusted_peers()
