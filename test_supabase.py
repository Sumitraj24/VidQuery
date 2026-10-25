import os
import httpx
from dotenv import load_dotenv

# Monkey patch httpx for Sophos SSL interception
_original_client_init = httpx.Client.__init__
def _patched_client_init(self, *args, **kwargs):
    kwargs['verify'] = False
    _original_client_init(self, *args, **kwargs)
httpx.Client.__init__ = _patched_client_init

_original_async_client_init = httpx.AsyncClient.__init__
def _patched_async_client_init(self, *args, **kwargs):
    kwargs['verify'] = False
    _original_async_client_init(self, *args, **kwargs)
httpx.AsyncClient.__init__ = _patched_async_client_init

load_dotenv()
from supabase import create_client

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")

try:
    sb = create_client(url, key)
    # just try to login with a bad password to see if it reaches the server
    sb.auth.sign_in_with_password({"email": "test@test.com", "password": "badpassword123"})
except Exception as e:
    print(f"Exception: {e}")

