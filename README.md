# Gestor Financiero portable para Windows

Dashboard React + TypeScript + Vite con Electron y Express. Conserva el diseño blanco y azul, gráficas, filtros, CSV y la separación entre ingresos, gastos, transferencias y aportaciones a inversión.

## Escritorio y objetivo del homelab

La arquitectura permite reutilizar el mismo servidor Express en dos modos. En el portable de Windows, Electron inicia Express y abre la interfaz en una ventana de escritorio. Para el homelab, el objetivo es ejecutar Express como servicio independiente en Node.js y abrir Mi Balance desde el navegador de otros dispositivos de la red. Express sirve tanto la interfaz compilada como la API y mantiene el token de Notion en el servidor.

El modo independiente ya arranca con `npm run build` y `npm start`, con acceso local en `127.0.0.1`. Habilitar el acceso desde otros equipos del homelab requiere configurar el acceso de red o un proxy inverso, adaptar las validaciones de Host y Origin al dominio usado y añadir autenticación de usuarios.

## Generar el portable

En el ordenador donde compilas necesitas Node.js 22.12 o superior y acceso a Internet para descargar dependencias y herramientas de Electron Builder:

```sh
npm install
npm run dist
```

Salida prevista para Windows x64:

```text
release/GestorFinanciero-1.0.0-Portable.exe
```

Antes de compilar, completa el archivo `.env` del proyecto (puedes partir de `.env.example`):

```dotenv
NOTION_TOKEN=
NOTION_MOVIMIENTOS_DATABASE_ID=
NOTION_CUENTAS_DATABASE_ID=
NOTION_FONDOS_DATABASE_ID=
NOTION_PAGOS_DATABASE_ID=
NOTION_OPERACIONES_DATABASE_ID=
NOTION_HOME_URL=
```

Completa el token y los identificadores de las cinco bases originales de tu espacio de Notion. La URL de **Abrir Notion** es opcional y se configura en `NOTION_HOME_URL`. La integración requiere lectura en las cinco bases, creación de páginas en Pagos previstos, Movimientos y Operaciones de fondos, y edición en Movimientos y Pagos previstos. `npm run dist` incluye la configuración en el portable. El ordenador de destino necesita conexión a Internet para consultar Notion y las fuentes de valoración. Si cambias las credenciales, vuelve a compilar.

Este ejecutable incluye tus credenciales personales de Notion y es para tu uso personal. El empaquetado no cifra los secretos: alguien con acceso al `.exe` puede extraerlos. No publiques el ejecutable ni subas el `.env` a un repositorio. La configuración incluida prevalece sobre las variables del entorno. El `.env` junto al ejecutable ya no se utiliza.

Electron Builder extrae internamente el portable a una carpeta temporal. La configuración se lee desde el paquete interno `app.asar`, sin necesitar archivos junto al ejecutable. Electron puede guardar su caché y preferencias en el perfil de Windows. El ejecutable no está firmado digitalmente: Windows puede mostrar un aviso de reputación o de editor desconocido.

## Arranque y cierre

Electron importa `server/index.js` en su proceso principal y llama a `startServer()`. Express escucha exclusivamente en `127.0.0.1`, sirve `dist` y gestiona las consultas y escrituras bajo `/api`. Electron limita el escritorio a una instancia por perfil. Las escrituras se serializan dentro del proceso de Express. Si se despliega el servidor por separado, las instancias que compartan las mismas bases tienen que centralizar las escrituras o compartir un mecanismo de idempotencia.

Al cerrar la última ventana, Electron aborta las consultas pendientes de Notion, cierra las conexiones HTTP y espera el cierre del servidor antes de terminar. Los errores de arranque se muestran en un diálogo sin incluir secretos.

El renderer usa `contextIsolation: true`, `nodeIntegration: false` y `sandbox: true`, sin APIs privilegiadas expuestas. Se validan Host, Origin y Fetch Metadata, se aplica CSP y no se habilita CORS. Las solicitudes legítimas sin Origin siguen admitidas; esto no autentica frente a otros procesos locales del usuario. Se bloquean navegaciones ajenas y nuevas ventanas; solo enlaces HTTPS de Notion se abren en el navegador del sistema. El token solo se usa en el servidor para HTTPS con Notion.

## Desarrollo y servidor independiente

```sh
npm run server
npm run dev
```

Ejecuta estos comandos en terminales distintas y abre `http://127.0.0.1:5173`. Vite reenvía `/api` a Express en `127.0.0.1:3001`; React utiliza siempre rutas relativas. `npm run server` admite exclusivamente los orígenes de desarrollo locales de Vite, además del propio servidor.

```sh
npm run build
npm start
```

Sirve la compilación en `http://127.0.0.1:3001`. `npm start` carga el `.env` del proyecto y permite cambiar el puerto mediante la variable de entorno `PORT`. En este modo solo se admite el origen propio. Importar el módulo del servidor no carga configuración ni abre ningún puerto.

```sh
npm run electron
```

Compila y abre Electron con Express integrado, usando el `.env` del proyecto y un puerto dinámico.

En PowerShell con ejecución de scripts deshabilitada puedes utilizar `npm.cmd` en lugar de `npm`.

## Datos financieros

Se mantiene la API de Notion, versión `2022-06-28`, con paginación de 100 elementos y límite de 10.000 registros. Se conservan la normalización y los nombres alternativos de propiedades.

- Movimientos: `Name`/`Nombre`/`Concepto`, `Movimiento`, `Tipo`/`Categoría`, `Valor`/`Importe` y `Date`/`Fecha`.
- Cuentas: `Name`/`Nombre`/`Cuenta` y `Saldo actual`/`Saldo Actual`/`Saldo` numérico o fórmula numérica.
- MyInvestor se excluye de las cuentas bancarias por nombre, ya que este esquema no distingue el saldo efectivo del valor de mercado de la cartera. Sus aportaciones registradas como movimientos se conservan. Para incluir exclusivamente su efectivo haría falta una propiedad que lo identifique expresamente.
- Pagos previstos: el panel derecho calcula las ocurrencias del mes en Europe/Madrid. Confirmar crea un gasto con la fecha y cuenta reales. Vincular solo añade el seguimiento al gasto seleccionado. Editar recalcula las ocurrencias pendientes y eliminar archiva la previsión en Notion. Los gastos ya registrados conservan su fecha y su importe. La edición y el archivado requieren permiso de actualización en Pagos previstos.

## Fuentes de los fondos y balance de inversiones

**Notion** aporta el nombre, el ISIN, la divisa, las participaciones y el coste de apertura de cada fondo desde la base **Fondos de inversión**. La base **Operaciones de fondos** aporta el historial de compras y ventas. Express combina ambos registros para calcular las participaciones efectivas y el coste restante. En una venta, reduce el coste según el coste medio de las participaciones vendidas. El importe recibido se conserva en la operación.

**Valor liquidativo.** Express consulta Quefondos por ISIN y, para los fondos configurados en [`server/alternative-quotes.js`](server/alternative-quotes.js), también consulta el histórico público de Vanguard España o la ficha del fondo en Finect. Usa la cotización válida más reciente y da prioridad a Quefondos en caso de empate. El panel indica la fecha y la fuente elegidas. [Quefondos](https://www.quefondos.com/es) · [Vanguard España](https://www.es.vanguard/profesionales) · [Finect](https://www.finect.com/fondos-inversion)

Si las fuentes consultadas fallan, el panel puede mostrar la última cotización válida guardada para ese ISIN y divisa. Electron guarda las cotizaciones en la carpeta `valoraciones` de su perfil. El servidor independiente usa `%LOCALAPPDATA%/Gestor Financiero/valoraciones` en Windows.

**Cálculo del balance.** El valor de cada posición es `participaciones efectivas × valor liquidativo`. El **valor actual de la cartera** suma los valores disponibles en euros. El **total invertido** suma los costes restantes. La **ganancia o pérdida** es `valor actual − coste restante` y su porcentaje se calcula sobre el coste restante cuando es positivo. Si faltan cotizaciones en euros para posiciones abiertas, el panel indica la cobertura parcial y deja pendiente la rentabilidad total.

El cálculo se implementa en [`server/fund-operations.js`](server/fund-operations.js). La selección de cotizaciones se implementa en [`server/fund-quotes.js`](server/fund-quotes.js).

## Verificaciones

```sh
npm test
npm run test:electron
npm run dist
npm audit --offline=false
```

Las pruebas del servidor simulan Notion y las fuentes de valoración. Comprueban las recurrencias, la confirmación y vinculación de pagos, la protección ante reintentos, los permisos, el coste medio y la aceptación de la cartera. También cubren la selección de cotizaciones, la protección de origen y host, la paginación y el cierre de sockets. `dist` debe existir para verificar la interfaz estática.

La prueba de Electron abre una ventana con datos simulados, comprueba los paneles de inversiones y pagos previstos, las consultas de Express y las opciones de aislamiento, y cierra la ventana. El informe `.verify/electron/result.json` incluye el puerto utilizado para verificar el cierre.

En entornos restringidos, `spawn EPERM` al lanzar esbuild, Electron o herramientas del empaquetador indica que no se han podido ejecutar los subprocesos necesarios. En ese caso es necesario ejecutar las comprobaciones en una terminal de Windows que permita esos procesos. Un resultado de `npm audit` sin conexión o con caché no acredita una auditoría actualizada.
