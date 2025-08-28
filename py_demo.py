import requests, subprocess, yaml, pickle

def greet(name):
    print("Hello", name)  # should trigger style (print)
    # requests without timeout + http
    requests.get("http://example.com")
    # dangerous
    subprocess.run("echo 1", shell=True)
    data = pickle.loads(b"...")
    # yaml without SafeLoader
    yaml.load("a: 1")
