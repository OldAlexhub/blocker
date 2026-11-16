-- Run ONCE as a PostgreSQL superuser (e.g. the "postgres" user), from psql:
--   psql -U postgres -f scripts/db-setup.sql
-- Creates a dedicated role and database. Does not touch any other database.
-- Change the password below before running, and put the same one in DATABASE_URL.

CREATE ROLE nexus_scheduler WITH LOGIN PASSWORD 'CHANGE_ME' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE nexus_scheduler OWNER nexus_scheduler;
REVOKE ALL ON DATABASE nexus_scheduler FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE nexus_scheduler TO nexus_scheduler;
