#!/bin/bash
cd "$(dirname "$0")" && /usr/bin/env python3 manage.py start
echo; echo "Classic Bookshelf is running. You can close this window."
