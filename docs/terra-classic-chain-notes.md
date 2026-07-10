# Notas técnicas de Terra Classic (LUNC) — para el proyecto Rueda del Repeg

Extraído el 2026-07-07 de la documentación oficial de la comunidad: [github.com/terra-classic-io/website](https://github.com/terra-classic-io/website) (rama `main`, carpeta `src/docs/`), más consultas en vivo al LCD público. Estos son parámetros de gobernanza y pueden cambiar — antes de confiar en un número para producción, re-consultar el LCD.

## Redes

- **Mainnet:** `columbus-5`
- **Testnet oficial:** `rebel-2` — usar para prototipar antes de tocar mainnet.
- Public infra (LCD/RPC/FCD/gRPC) es solo para desarrollo/cargas livianas; para producción, correr nodo propio o infra dedicada.

### Endpoints públicos (columbus-5)

| Tipo | URL |
| --- | --- |
| LCD | `https://terra-classic-lcd.publicnode.com` |
| LCD (alt) | `https://api-lunc-lcd.binodes.com` |
| LCD (alt) | `https://lcd.terra-classic.hexxagon.io` |
| RPC | `https://terra-classic-rpc.publicnode.com` |
| FCD | `https://terra-classic-fcd.publicnode.com` |
| gRPC | `grpc+https://terra-classic-grpc.publicnode.com` |
| LCD Swagger/OpenAPI | `https://terra-classic-lcd.publicnode.com/swagger/index.html` |

Testnet `rebel-2` tiene sus propios endpoints equivalentes en hexxagon/luncblaze (ver `endpoints.md` del repo).

## Burn tax (`x/tax`) — lo más importante para el proyecto

- **Tasa vigente confirmada en vivo (2026-07):** `burn_tax_rate = 0.5%` — consultado en `GET /terra/tax/v1beta1/params`. Es un parámetro de gobernanza, **no hardcodear**; consultar en runtime.
- Reparto del tax recaudado: **80% se quema permanentemente, 20% se reparte entre recompensas de oráculo y community pool** (`burn_tax_split: 0.20` en `/terra/treasury/v1beta1/params`). Confirmado también empíricamente en transacciones reales (evento `tax_payment`, `reverse_charge: true`, split 10/10/80).
- La wallet de quema confirmada por el usuario: `terra1sk06e3dyexuq4shw77y3dsv480xv42mq73anxu`.
- **Dato clave: enviar fondos adjuntos a un `MsgExecuteContract` (el campo `funds`/`coins`) es libre de tax.** Confirmado explícitamente en la doc oficial (`classic-transaction-behavior.md`): *"Sending funds to a contract is tax-free on Terra Classic."* Esto es distinto de un `BankMsg::Send` saliente, que sí puede pagar el tax.
- Los activos IBC puenteados (como el USDC que usa el proyecto) no parecen estar registrados como denom taxable — no se observó tax sobre el denom IBC en las transacciones analizadas.
- **Implicancia directa para el contrato de redención:** si el ganador manda USTC como `funds` adjuntos a la llamada de redención (no como un send suelto), y el contrato responde con USDC vía `BankMsg::Send`, ninguno de los dos tramos debería pagar burn tax. Falta validar en testnet antes de asumirlo en mainnet.
- Existe el módulo **`x/taxexemption`**: la gobernanza puede definir "zonas" de direcciones completamente exentas del tax (`incoming`/`outgoing`/`cross_zone`). Es un trámite de gobernanza (propuesta + votación), no algo unilateral — posible camino futuro si se quisiera blindar el proyecto del tax por completo.
  - Endpoints: `/terra/taxexemption/v1/zones`, `/terra/taxexemption/v1/{zone}/addresses`, `/terra/taxexemption/v1/taxable/{from}/{to}`.

## Otros módulos relevantes

- **`x/market` (deshabilitado):** los swaps algorítmicos LUNC↔stablecoin están desactivados desde mayo 2022 (post-colapso). No construir nada que dependa de esa mecánica; usar DEXes activos (ej. Terraport) para exchange de activos.
- **`x/oracle`:** solo alimenta tasas de cambio (para tax y analíticas), votadas por validadores cada 5 bloques (`VotePeriod`). **No hay VRF ni randomness nativa en la cadena.** Para el sorteo de la rueda, las únicas opciones reales son commit-reveal o usar el hash de un bloque futuro — no hay atajo nativo.
- **`x/treasury` (legado, mayormente inactivo):** el mecanismo viejo de "stability tax"/seigniorage está en 0% desde propuestas 43 y 172; el burn tax actual (`x/tax`) es un mecanismo nuevo y separado, introducido por la propuesta de gobernanza 12148 (2025). No confundir ambos.
- **`x/wasm`:** motor CosmWasm estándar — contratos con `code_id` (subida de bytecode) separado de la instancia (`MsgInstantiateContract`), direcciones de contrato determinísticas por orden de creación. Entry points: `instantiate()`, `execute()`, `query()`, opcionalmente `migrate()`.

## Gobernanza (para una eventual propuesta de tax-exemption)

- Depósito mínimo: 50 LUNC, período de depósito 2 semanas.
- Período de votación: 1 semana. Opciones: Yes/No/NoWithVeto/Abstain. Los delegadores pueden overridear el voto de su validador.
- Quorum: 40% de participación. Umbral de veto aplica.
- Tipos comunes: cambios de parámetro, gasto de community pool, propuestas de texto.

## Staking (contexto general, no crítico para el juego)

- Unbonding: 21 días, sin recompensas durante ese período.
- Comisión de validadores: típicamente 2.5%–20%.
- Slashing: double-signing, downtime, fallas de oráculo.

## Desarrollo de contratos (CosmWasm)

- Lenguaje: Rust. Template recomendado: `cargo generate --git https://github.com/CosmWasm/cw-template.git --branch 1.5 --name <nombre>`.
- Flujo: escribir contrato → `cargo wasm` → optimizar con Docker (`cosmwasm/workspace-optimizer`) o `wasm-opt` → `terrad tx wasm store` (sube código, devuelve `code_id`) → `terrad tx wasm instantiate <code_id> '<InitMsg>'` (crea la instancia, devuelve `contract_address`) → `terrad tx wasm execute <address> '<ExecuteMsg>'`.
- Local dev: Rust 1.82, target `wasm32-unknown-unknown`, `cargo-generate`, `wasm-opt`. Localnet expone RPC en `26657` y LCD en `1317`.
- Contratos de ejemplo: [github.com/CosmWasm/cosmwasm/tree/main/contracts](https://github.com/CosmWasm/cosmwasm/tree/main/contracts).
- CW20 (tokens fungibles al estilo ERC20): interactuar vía `MsgExecuteContract` con mensajes `transfer`, `send` (transfiere + ejecuta mensaje en el contrato receptor), `balance` (query). Relevante si en algún momento el proyecto emite su propio token.

## SDK recomendado para frontend

- **[`@goblinhunt/cosmes`](https://www.npmjs.com/package/@goblinhunt/cosmes)** — SDK de JS/TS enfocado en Terra Classic, cubre LCD/RPC/gRPC y helpers de CosmWasm (incluye `MnemonicWallet`, `MsgExecuteContract`, `getCw20Balance`, etc.). Es la opción recomendada por la propia documentación oficial por sobre el viejo `terra.py`/Terra SDK.
- Wallets soportadas: Keplr, Cosmostation, Station/Galaxy Station.

## Fuente y cómo actualizar estas notas

Repo: `https://github.com/terra-classic-io/website` — docs en `src/docs/develop/` (specs de módulos en `module-specifications/`, guías de contratos en `smart-contracts/`, SDK en `cosmes/`) y `src/docs/learn/` (fees, protocolo, glosario). Se puede leer cualquier archivo directo vía `https://raw.githubusercontent.com/terra-classic-io/website/main/<path>`, y listar carpetas vía `https://api.github.com/repos/terra-classic-io/website/contents/<path>`.

Como son parámetros de gobernanza vivos, antes de una implementación real conviene re-verificar `burn_tax_rate` y el estado de `taxexemption` contra el LCD en el momento, no confiar ciegamente en lo anotado acá.
