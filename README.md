# correos

MVP de envio de correos por lotes con:
- importacion desde Excel,
- PostgreSQL + Prisma,
- worker SMTP (modo gratis para empezar),
- supresion global (unsubscribe, complaint, hard bounce),
- endpoint de webhooks/eventos.

## 1) Levantar local

1. Copia variables:
   - `cp .env.example .env`
2. Instala dependencias:
   - `npm install`
3. Levanta Postgres en Docker:
   - `npm run db:up`
4. Crea tablas con Prisma:
   - `npm run db:push`

## 2) Flujo por panel (sin terminal para cada paso)

1. Inicia el panel:
   - `npm run server:panel`
2. Abre `http://localhost:3000`
3. Desde la UI:
   - Importa Excel por ruta local
   - Crea campana
   - Encola campana
   - Procesa 1 lote o inicia worker automatico

## 3) Flujo por terminal (alternativo)

1. Importar Excel
   - `npm run import:excel -- ./contactos.xlsx --source landing`
2. Crear campana
   - `npm run campaign:create -- --name "Promo Marzo" --subject "Novedades"`
3. Encolar campana
   - `npm run campaign:queue -- 1`
4. Ejecutar worker de envio
   - `npm run worker:send`
5. Levantar server de webhooks/unsubscribe
   - `npm run server:webhooks`

## 4) Formato Excel recomendado

Columnas minimas:
- `email` (obligatoria)
- `nombre` o `name` (opcional)
- `consentimiento_fecha` (opcional, recomendado)
- `origen` (opcional)

## 5) Variables importantes

- `FREE_DAILY_LIMIT`: limite diario gratis (ej. 300)
- `BATCH_SIZE`: mensajes por ciclo del worker
- `LOOP_INTERVAL_SECONDS`: espera entre ciclos
- `UNSUBSCRIBE_BASE_URL`: base para generar link de baja

## 6) Endpoints

- `GET /health`
- `GET /unsubscribe?email=...`
- `POST /webhooks/events`

Ejemplo webhook:

```json
{
  "provider": "smtp",
  "eventType": "complaint",
  "providerEventId": "evt_123",
  "providerMessageId": "<abc@mail> ",
  "recipientEmail": "user@example.com",
  "meta": { "detail": "spam complaint" }
}
```

## 7) Escalado despues

Cuando inviertas dinero, cambia solo el adaptador de envio SMTP/API y manten el resto:
- misma base de datos,
- misma logica de supresion,
- misma cola/worker.
