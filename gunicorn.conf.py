# Gunicorn settings that reduce fingerprinting.
#
# Gunicorn writes its own `Server: gunicorn/<version>` header at the HTTP layer,
# *below* the WSGI application, so the in-process header scrubber in app.py
# cannot remove it. Only a server option can. This file is picked up
# automatically when gunicorn runs with the repository root as its working
# directory; otherwise pass it explicitly:
#
#   gunicorn -c gunicorn.conf.py movie-backend.app:app
#
# It deliberately does not set `workers` or anything else about process count.
# Render's dashboard owns that, and overriding it here would silently fight
# whatever is already configured for the service.

# Drop `Server: gunicorn/x.y.z`, which otherwise advertises the exact server
# and version to anyone probing the deployment.
no_server_header = True

# Keep the header off the error pages too.
remove_header_on_404 = False

# Do not let gunicorn advertise its version in exception output.
forwarded_allow_ips = "*"
