# Mi Balance · Resumen para continuar el desarrollo

Fecha de revisión del código: 26 de noviembre de 2026.

## 1. Objetivo y estado actual

Mi Balance es la interfaz de Gestor Financiero, una aplicación de escritorio para Windows que consulta cuentas, movimientos y fondos almacenados en Notion. El Resumen incluye un panel de pagos previstos y otro de inversiones. Desde la aplicación se pueden gestionar las previsiones, confirmar o vincular gastos y registrar compras y ventas de fondos.

La última entrega local es `release/GestorFinanciero-1.0.0-Portable-Gestion-Pagos.exe`. Incorpora la edición y el archivado de pagos previstos.

## 2. Arquitectura del proyecto

Electron ejecuta Express en su proceso principal y abre la ventana cuando el servidor está escuchando en `127.0.0.1` con un puerto dinámico. Express sirve la interfaz React compilada y la API local. Notion almacena los datos financieros. Express consulta también las fuentes públicas de valoración y guarda la última cotización válida por ISIN y divisa.

La navegación entre **Resumen** y **Movimientos** usa estado de React. **Actualizar datos** vuelve a consultar las cuentas, los movimientos, la cartera y el mes visible de pagos. Los filtros de movimientos se aplican en memoria y son independientes de la cartera y del mes del panel de pagos.

| Archivo | Responsabilidad |
| --- | --- |
| `src/App.tsx` y `src/App.css` | Dashboard, filtros, exportación CSV y estilos. |
| `src/Payments.tsx` | Panel mensual de pagos previstos y formularios de gestión. |
| `src/Portfolio.tsx` | Valoración de la cartera, resultados por fondo y registro de operaciones. |
| `src/ActionDialog.tsx` y `src/api.ts` | Diálogos, envío de formularios, claves de reintento y cliente HTTP de la interfaz. |
| `server/index.js` y `server/notion.js` | Configuración, rutas locales, normalización y cliente de Notion. |
| `server/payments.js` | Ocurrencias, confirmación, vinculación, edición y archivado de previsiones. |
| `server/fund-operations.js` | Reconstrucción de posiciones, coste medio y valoración de la cartera. |
| `server/fund-quotes.js`, `server/quefondos.js`, `server/alternative-quotes.js` y `server/quote-format.js` | Selección, caché y análisis de cotizaciones. |
| `server/workflow.js` | Validación de identificadores y fechas, serialización y conciliación de escrituras. |
| `electron/main.cjs` | Instancia única por perfil, arranque, ventana, navegación y cierre. |

### API local de Express

Las rutas usan `POST`. Los datos se devuelven en `result.structuredContent` y los errores incluyen un mensaje de aplicación.

| Ruta | Uso |
| --- | --- |
| `/api/configuracion` | Devuelve la URL del botón **Abrir Notion**. |
| `/api/movimientos` | Lee los movimientos para la tabla, los indicadores y el CSV. |
| `/api/cuentas` | Lee las cuentas y sus saldos. |
| `/api/fondos` | Lee posiciones y cotizaciones. Devuelve el detalle de cada fondo y el resumen de cartera. |
| `/api/fondos/operaciones` | Valida y registra una compra o venta. |
| `/api/pagos` | Lista las ocurrencias del mes, el total pendiente y las opciones de cuenta y categoría. |
| `/api/pagos/crear`, `/api/pagos/editar` y `/api/pagos/eliminar` | Crean, actualizan o archivan la definición del pago. |
| `/api/pagos/pagar` | Registra un gasto real para una ocurrencia. |
| `/api/pagos/candidatos` y `/api/pagos/vincular` | Buscan gastos existentes y vinculan el elegido con una ocurrencia. |

## 3. Tecnología usada

El proyecto requiere Node.js `>=22.12.0` para desarrollo y empaquetado. Utiliza React 18, TypeScript 5, Vite 6, Express 4, Electron 45 y Electron Builder 26. Cheerio analiza las fichas públicas de valoración, Decimal.js mantiene la precisión en las operaciones de fondos y Lucide React proporciona los iconos. Las gráficas usan HTML y CSS. Los importes se presentan con `Intl.NumberFormat` en español.

## 4. Funcionalidad y reglas de cálculo

### Cuentas y movimientos

- El saldo total suma las cuentas en EUR. La cartera de MyInvestor se presenta por separado del efectivo.
- Los indicadores suman ingresos y gastos del conjunto filtrado. La categoría exacta `Inversion` se excluye del indicador y gráfico de gastos. Las transferencias se muestran por separado.
- El periodo inicial es el mes natural actual en `Europe/Madrid`. **Todo el historial** quita el límite temporal. En **Personalizado**, Desde y Hasta son inclusivos. Si solo se indica Desde, el límite superior es hoy. Si solo se indica Hasta, se incluyen las fechas anteriores hasta ese día.
- Se pueden combinar categoría, tipo de movimiento y búsqueda por concepto o categoría. El gráfico circular permite aplicar o quitar el filtro por categoría. **Limpiar** restablece la búsqueda, la categoría y el tipo, y conserva el periodo.
- El CSV exporta los movimientos filtrados con fecha, concepto, tipo, categoría e importe. Usa separador de punto y coma y BOM UTF-8.

### Pagos previstos

- El panel derecho abre en el mes actual de Madrid y permite navegar por meses. Ordena las ocurrencias por fecha y suma los importes pendientes.
- Express genera las ocurrencias bajo demanda. Un intervalo de `0` representa un pago único. Las recurrencias usan el día de la primera fecha como ancla y lo ajustan al último día de los meses más cortos.
- **Marcar como pagado** propone el importe previsto y la cuenta habitual. Al confirmar, registra un gasto en Movimientos con la fecha, el importe y la cuenta reales. El gasto se vincula mediante `Pago previsto`, `Fecha prevista` y `Clave de ocurrencia`. La clave usa el formato `<UUID canónico>:<YYYY-MM-DD>` y permite ver el pago en el mes previsto aunque el gasto se registre en otro mes.
- **Vincular gasto existente** permite seleccionar un gasto, por ejemplo uno registrado desde el Atajo. La vinculación modifica únicamente los tres campos de seguimiento.
- **Editar** permite cambiar concepto, importe, primera fecha, categoría, cuenta habitual y frecuencia. Las ocurrencias pendientes se recalculan. Si ese mes ya tiene un gasto vinculado, conserva la fecha prevista original y evita generar una segunda obligación.
- **Eliminar** pide confirmación y archiva la definición en Notion. Las ocurrencias pendientes salen de la planificación y los gastos vinculados permanecen visibles en el mes previsto, con su fecha e importe reales.

### Inversiones

- `Participaciones` y `Coste de adquisición` en Fondos de inversión representan la posición de apertura. **Registrar operación** añade una compra o venta en Operaciones de fondos. El flujo de caja se registra por separado en Movimientos.
- Express reproduce el historial por fecha efectiva, fecha de creación e ID. Una compra suma participaciones y coste. Una venta reduce el coste al precio medio de adquisición y guarda el importe recibido en la fila de la operación. Al cerrar una posición, sus participaciones y coste restante quedan en cero.
- El servidor rechaza fechas efectivas futuras y ventas que excedan las participaciones disponibles. Las inserciones retroactivas se validan contra toda la secuencia.
- El valor actual multiplica participaciones efectivas por valor liquidativo. **Total invertido** suma los costes restantes. El resultado en euros es valor actual menos coste y el porcentaje se calcula sobre el coste total. Con coste cero o desconocido, el porcentaje queda pendiente. Si faltan valoraciones de posiciones abiertas en EUR, el total de mercado se marca como parcial o no disponible y se omite la rentabilidad total.

### Valor liquidativo y variación diaria

| ISIN | Fuente alternativa |
| --- | --- |
| `IE0007987708` y `IE0031786142` | Vanguard España, tabla «Precios históricos». |
| `IE00BYX5NX33` | Finect, objeto `lastQuote` del fondo principal. |

Express consulta en paralelo Quefondos y la fuente alternativa configurada. Selecciona la cotización válida más reciente y prioriza Quefondos en empate. Los ISIN nuevos disponen de Quefondos. Si fallan todas las fuentes consultadas, el panel puede recuperar la última cotización válida guardada con su fecha y fuente originales.

Vanguard calcula la variación comparando el precio seleccionado con el registro inmediatamente anterior. Finect usa `percentChange` cuando está disponible y Quefondos usa la variación publicada en la ficha. El panel muestra **Sin dato diario** si falta un valor válido. Los fallos de las fuentes alternativas se registran en Express.

## 5. Integración, permisos y escrituras

`.env.example` enumera las variables de configuración. La API usa la versión `2022-06-28` y los ID de las bases originales. El `.env` local contiene `NOTION_TOKEN` y los cinco identificadores obligatorios. `NOTION_HOME_URL` permite configurar el enlace **Abrir Notion**.

La integración necesita lectura en Movimientos, Cuentas bancarias, Fondos de inversión, Pagos previstos y Operaciones de fondos. También requiere creación en Movimientos, Pagos previstos y Operaciones de fondos, y actualización en Movimientos para vincular gastos y en Pagos previstos para editar o archivar.

El cliente de Notion usa páginas de 100 registros y limita cada consulta a 10.000. Las peticiones tienen un tiempo máximo de 30 segundos e incluyen reintentos ante `HTTP 429`. El servidor consulta las categorías del campo `Tipo` de la base original de Movimientos y utiliza su relación `Cuenta bancaria` para alimentar el cálculo de gastos de las cuentas.

Las escrituras relacionadas se serializan en memoria dentro del proceso de Express. Se usan claves de ocurrencia para los gastos y UUID de operación para las compras y ventas. Si Notion no confirma una escritura, Express vuelve a consultar antes de resolverla o de permitir un nuevo envío. Mientras el resultado siga incierto, el reintento comprueba el registro. Si se despliegan varios procesos escritores, la idempotencia debe compartirse entre ellos.

## 6. Ejecución y empaquetado

| Comando | Resultado |
| --- | --- |
| `npm install` | Instala dependencias. |
| `npm run server` y `npm run dev` | Ejecutan Express y Vite en terminales distintas. Vite reenvía `/api` al puerto 3001. |
| `npm run build` y `npm start` | Compilan la interfaz y la sirven con Express. |
| `npm run electron` | Compila la interfaz y abre la aplicación de escritorio. |
| `npm run dist` | Genera el portable Windows x64 en `release/`. |
| `npm test` | Ejecuta las pruebas del servidor. |
| `npm run test:electron` | Compila y ejecuta la prueba de ventana de Electron. |

En PowerShell se puede usar `npm.cmd` si la política bloquea `npm.ps1`. El empaquetado estándar genera `release/GestorFinanciero-1.0.0-Portable.exe`. El equipo de destino necesita conexión a Notion y a las fuentes de valoración.

En Electron, `.env` se carga desde el contenido de la aplicación. El archivo empaquetado tiene prioridad sobre las variables de entorno. Cambiar credenciales en la versión portable requiere reconstruirla. Las credenciales incluidas son extraíbles de `app.asar`, por lo que el ejecutable es de uso personal.

## 7. Seguridad y persistencia local

Express valida Host, Origin y Fetch Metadata en el puerto local, aplica CSP y mantiene el token en el servidor. La ventana usa `contextIsolation: true`, `nodeIntegration: false` y `sandbox: true`. Electron limita la aplicación a una instancia por perfil y cancela las consultas pendientes al cerrar.

Notion conserva los registros de negocio. La persistencia local de cotizaciones se guarda en `valoraciones` dentro del perfil de Electron. El servidor independiente usa `%LOCALAPPDATA%/Gestor Financiero/valoraciones` en Windows. Los filtros se aplican al historial cargado y la actualización depende de la apertura del panel, de las acciones de escritura y del botón **Actualizar datos**.

## 8. Pruebas y estado de validación

- `npm test` pasó **16 pruebas** en esta revisión. `tests/server.test.js` cubre configuración, paginación, cotizaciones, seguridad y cierre. `tests/workflows.test.js` cubre recurrencias, vínculos, edición y archivado de previsiones, reintentos y coste medio.
- En las últimas entregas se comprobó la interfaz compilada con datos simulados y se verificó la integridad del portable de gestión de pagos. La prueba de ventana nativa `tests/electron-smoke.cjs` quedó bloqueada por los permisos de Windows en el entorno de verificación.
- La integración real leyó las cinco bases desde Express y se verificó el cálculo del coste restante, el valor de mercado y la rentabilidad de la cartera.
- Las pruebas de escritura usaron Notion simulado. Los permisos reales de creación y actualización quedan pendientes de confirmar.

## 9. Documentos de referencia

- [README.md](../README.md) contiene los comandos, la configuración y las instrucciones de empaquetado.
- [server/fund-quotes.js](../server/fund-quotes.js) contiene la selección y la caché de cotizaciones.
