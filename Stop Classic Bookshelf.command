#!/bin/bash
cd "$(dirname "$0")" && /usr/bin/env python3 manage.py stop
echo; echo "Stopped. You can close this window."
