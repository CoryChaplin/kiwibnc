# AI Context & Guidelines for Kiwibnc

This document provides context, architectural overview, and guidelines for AI agents (and human developers) contributing to the Kiwibnc project.

## 1. Project Overview

Kiwibnc is a modern, multi-user IRC bouncer built with Node.js. It is designed to be scalable and robust, supporting zero-downtime updates and restarts.

**Key Features:**
*   **Split Architecture:** Separates socket handling from application logic.
*   **Extensible:** Uses a plugin/extension system.
*   **Database Agnostic:** Supports SQLite, MySQL, and PostgreSQL via Knex.
*   **IRCv3 Support:** Built on top of `irc-framework`.

## 2. Architecture

The application is split into two main processes to ensure stability and zero-downtime updates:

1.  **Socket Layer (`src/sockets/`)**:
    *   Handles raw TCP connections (incoming from clients, outgoing to IRC servers).
    *   Minimal logic to reduce crash risk.
    *   Passes data to the worker process.

2.  **Worker Layer (`src/worker/`)**:
    *   Contains the core application logic.
    *   Handles IRC protocol parsing, user management, database interactions, and extensions.
    *   Can be restarted without dropping TCP connections held by the socket layer.

**Communication:**
*   The two layers communicate via a queue system.
*   **IPC**: Used for single-instance deployments (default).
*   **AMQP (RabbitMQ)**: Used for scalable/distributed deployments.

## 3. Directory Structure

*   `src/server.js`: Main entry point. Handles CLI arguments and starts the appropriate process (sockets or worker).
*   `src/sockets/`: Code for the socket layer.
*   `src/worker/`: Code for the worker layer (main logic).
*   `src/extensions/`: Built-in extensions (plugins).
*   `src/libs/`: Shared libraries and utilities (Database, Config, Logger, etc.).
*   `src/actions/`: CLI command implementations (adduser, run, etc.).
*   `src/dbschemas/`: Database migration files (Knex).
*   `src/dataModels/`: Data models (likely ORM-like wrappers).

## 4. Key Components

### The `app` Object
The `app` object is the central state container passed around the worker process. It typically contains:
*   `app.conf`: Configuration instance (`src/libs/config.js`).
*   `app.db`: Database connection instance (`src/libs/database.js`).
*   `app.queue`: Interface for communicating with the socket layer.
*   `app.cons`: `ConnectionDict` instance, holding all active connections.
*   `app.stats`: Statistics collector.

### Database
*   Uses `knex` query builder.
*   Abstraction layer in `src/libs/database.js`.
*   Two main databases:
    *   `connections.db`: Stores transient state (can be rebuilt, but used for persistence across restarts).
    *   `users.db`: Stores user accounts, networks, and configuration.
*   **Usage:** `app.db.get(sql, params)`, `app.db.all(sql, params)`, or accessing `app.db.dbUsers` (knex instance) directly.

### Extensions
*   Located in `src/extensions/`.
*   Entry point is `index.js` which exports an `init(hooks, app)` function.
*   Extensions can register hooks, add commands, and interact with the `app` object.

### Hooks System
*   Managed by `src/worker/hooks.js`.
*   Allows modifying messages, capabilities, and handling events.
*   **Common Hooks:**
    *   `available_caps`: Register new IRCv3 capabilities.
    *   `message_from_client`: Intercept/handle messages from the user's client.
    *   `message_to_client`: Intercept/modify messages going to the user's client.
    *   `connection_open` / `connection_close`.

## 5. Development Guidelines

### Coding Style
*   **Language:** JavaScript (Node.js).
*   **Async/Await:** Preferred for asynchronous operations.
*   **Logging:** Use the global `l` object (e.g., `l.info('message')`, `l.debug('message')`, `l.error('message', err)`).
*   **Variables:** `const` and `let`. Avoid `var`.

### Configuration
*   Configuration is loaded from `config.ini` (or similar).
*   Access via `app.conf.get('key.subkey', defaultValue)`.

### Creating a New Extension
1.  Create a folder in `src/extensions/<extension_name>`.
2.  Create `index.js`.
3.  Export `init(hooks, app)`.
4.  Register hooks or commands.
5.  Add the extension name to the `extensions.loaded` array in `config.ini` (or ensure it's loaded by default logic).

### Adding a CLI Command
1.  Create a file in `src/actions/`.
2.  Register the command in `src/server.js` using `commander`.

### Configuration Structure (`config.ini`)
*   **[listeners]**: Defines ports and protocols (TCP, WebSocket, HTTP) for incoming connections.
*   **[database]**: Configures the `state` (connections) and `users` databases.
*   **[queue]**: Configures the IPC mechanism (internal or AMQP).
*   **[logging]**: Configures message storage (SQLite, flat files, or custom).
*   **[webserver]**: Configures the built-in HTTP server.

## 6. Common Tasks for AI Agents

*   **Refactoring:** When refactoring, ensure the separation between `sockets` and `worker` is maintained. Do not put heavy logic in `sockets`.
*   **Database Changes:** If modifying the schema, create a new migration file in `src/dbschemas/`.
*   **New Features:** Prefer implementing new features as extensions in `src/extensions/` rather than modifying core worker logic, unless necessary.
*   **Context:** Always check `src/worker/worker.js` and `src/libs/bootstrap.js` to understand how the application initializes.

