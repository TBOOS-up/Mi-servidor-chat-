# Servidor del chat de Sebastian (estilo WhatsApp)

Este es el "cerebro" de la aplicación de mensajes: una computadora en internet
(el servidor) que recibe los mensajes de un teléfono y se los entrega al otro.
También guarda los chats, los mensajes y los estados.

**Lo que hace:**
- Registrar usuarios con su número de teléfono y nombre
- Crear chats de 1 a 1 entre dos teléfonos
- Enviar y recibir mensajes en tiempo real
- Publicar y ver estados (los de las últimas 24 horas)
- Preparado para llamadas (la señalización ya está lista, las llamadas de voz/video llegan en la fase 2)

**Limitación honesta del plan gratis:** en el plan gratis de Render la base de
datos vive en un archivo (`chat.db`) dentro del servidor. Mientras el servicio
esté corriendo, todo se guarda normal. Pero si Render apaga o reinstala el
servicio (pasa cuando nadie lo usa por un rato), ese archivo se borra y los
mensajes se pierden. Cuando la app crezca, se cambia a una base de datos
de verdad (de pago) y nada se pierde.

> Nota: en esta versión 1 el registro NO manda SMS de verificación de verdad.
> Eso llega después con un proveedor de SMS (es de pago).

---

## Probarlo en tu computadora

Necesitas tener [Node.js](https://nodejs.org) instalado (versión 18 o más).

```bash
cd chat-app/server
npm install
node index.js
```

Si ves `Servidor del chat escuchando en el puerto 3000`, ya está corriendo.
Para revisar que vive, abre en el navegador: http://localhost:3000/api/salud
Debe decir `{"ok":true}`.

---

## Subirlo a Render gratis (paso a paso)

1. **Crea una cuenta en Render:** entra a https://render.com y regístrate
   (puedes entrar con tu cuenta de Google o GitHub).
2. **Sube este código a GitHub:** crea un repositorio nuevo en
   https://github.com/new, súbelo, y asegúrate de que la carpeta `server`
   con estos archivos esté adentro.
3. **Crea el servicio web:** en Render, pulsa **New +** → **Web Service** →
   **Build and deploy from a Git repository** y elige tu repositorio.
4. **Configúralo así:**
   - **Root Directory:** `chat-app/server` (o `server`, según dónde quedó la carpeta)
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** Free
   - (El archivo `render.yaml` de esta carpeta ya trae estos valores.)
5. **Despliega:** pulsa **Deploy**. En unos minutos te da una dirección como
   `https://chat-app-servidor.onrender.com`.
6. **Comprueba que vive:** abre `https://TU-DIRECCION.onrender.com/api/salud`
   en el navegador. Debe decir `{"ok":true}`.

> En el plan gratis, la primera vez que se usa después de un rato apagado
> tarda ~30-60 segundos en "despertar". Es normal.
