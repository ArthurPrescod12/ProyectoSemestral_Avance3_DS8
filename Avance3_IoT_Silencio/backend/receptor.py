"""Recibe telemetría MQTT y registra cambios de comunicación de un ESP32."""
import argparse
import csv
import json
from datetime import datetime
from pathlib import Path
from threading import Lock
from time import monotonic, sleep

import paho.mqtt.client as mqtt

HOST = "broker.hivemq.com"
PREFIJO = "utp/ds8/grupo-demo/monitoreo-incendios-a3"
DISPOSITIVO = "ESP32_ESTACION_01"
CAMPOS = ("dispositivo_id", "gas_adc", "temperatura_c", "humedad_pct",
          "clasificacion", "alarma_activa", "umbral_gas")
ENCABEZADO_LECTURAS = ("fecha_recepcion", *CAMPOS, "buzzer_silenciado")


def fecha():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def guardar_csv(ruta, encabezado, fila):
    with ruta.open("a", encoding="utf-8", newline="") as archivo:
        escritor = csv.writer(archivo)
        if archivo.tell() == 0:
            escritor.writerow(encabezado)
        escritor.writerow(fila)


def leer_objeto(payload):
    if len(payload) > 1024:
        raise ValueError("mensaje demasiado largo")
    datos = json.loads(payload.decode("utf-8"))
    if type(datos) is not dict:
        raise ValueError("se esperaba un objeto JSON")
    return datos


def validar_telemetria(datos):
    for campo in CAMPOS:
        if campo not in datos:
            raise ValueError(f"falta {campo}")
    if datos["dispositivo_id"] != DISPOSITIVO:
        raise ValueError("dispositivo_id desconocido")
    gas = datos["gas_adc"]
    temperatura = datos["temperatura_c"]
    humedad = datos["humedad_pct"]
    umbral = datos["umbral_gas"]
    if type(gas) is not int or not 0 <= gas <= 4095:
        raise ValueError("gas_adc debe ser un entero de 0 a 4095")
    if type(temperatura) not in (int, float) or not -40 <= temperatura <= 80:
        raise ValueError("temperatura_c fuera del rango de -40 a 80")
    if type(humedad) not in (int, float) or not 0 <= humedad <= 100:
        raise ValueError("humedad_pct fuera del rango de 0 a 100")
    if type(umbral) is not int or not 1501 <= umbral <= 4095:
        raise ValueError("umbral_gas fuera del rango de 1501 a 4095")

    peligro = gas >= umbral or temperatura >= 40
    clasificacion = "NORMAL"
    if peligro:
        clasificacion = "PELIGRO"
    elif gas >= 1500 or temperatura >= 32:
        clasificacion = "ADVERTENCIA"
    if datos["clasificacion"] != clasificacion or datos["alarma_activa"] is not peligro:
        raise ValueError("clasificacion o alarma_activa no concuerdan con las lecturas")
    if "buzzer_silenciado" in datos:
        silenciado = datos["buzzer_silenciado"]
        if type(silenciado) is not bool or (silenciado and not peligro):
            raise ValueError("buzzer_silenciado debe ser booleano y solo puede activarse en PELIGRO")


class Monitor:
    def __init__(self, silencio, salida):
        self.silencio = silencio
        self.salida = salida
        self.estado = None
        self.conectado = None
        self.ultima_actividad = None

    def reiniciar_observacion(self):
        # Ante una caída del receptor no inferimos que el ESP32 esté offline.
        self.conectado = None
        self.ultima_actividad = None

    def cambiar(self, estado, detalle):
        if estado == self.estado:
            return
        gravedad = {"ONLINE": "INFO", "SIN_DATOS": "ADVERTENCIA", "OFFLINE": "CRITICA"}
        anterior = self.estado or "INICIO"
        detalle = f"{anterior} -> {estado}. {detalle}"
        guardar_csv(self.salida, ("fecha", "tipo", "gravedad", "detalle"),
                    (fecha(), estado, gravedad[estado], detalle))
        self.estado = estado
        print(f"[MONITOR] {gravedad[estado]} | {detalle}", flush=True)

    def presencia(self, estado):
        if estado == "offline":
            self.conectado = False
            self.ultima_actividad = None
            self.cambiar("OFFLINE", "El broker informó offline en el tema de estado.")
        elif self.conectado is not True:
            self.conectado = True
            self.ultima_actividad = monotonic()

    def telemetria(self):
        self.conectado = True
        self.ultima_actividad = monotonic()
        self.cambiar("ONLINE", "Se recibió telemetría válida.")

    def revisar_silencio(self):
        if self.conectado is True and monotonic() - self.ultima_actividad >= self.silencio:
            self.cambiar("SIN_DATOS", f"Pasaron {self.silencio} s sin telemetría válida.")


class Receptor:
    def __init__(self, prefijo, salida, silencio):
        self.prefijo = prefijo
        self.lecturas = salida / "historial_lecturas.csv"
        if self.lecturas.is_file():
            with self.lecturas.open(encoding="utf-8-sig", newline="") as archivo:
                encabezado = next(csv.reader(archivo), [])
            if encabezado and tuple(encabezado) != ENCABEZADO_LECTURAS:
                self.lecturas = salida / "historial_lecturas_con_silencio.csv"
                print(f"[CSV] El historial anterior se conserva. Nuevo historial: {self.lecturas}", flush=True)
        self.monitor = Monitor(silencio, salida / "eventos_comunicacion.csv")

    def conectar(self, cliente, _userdata, _flags, razon, _properties):
        self.monitor.reiniciar_observacion()
        if razon.is_failure:
            print(f"[MQTT] Conexión rechazada. {razon}", flush=True)
            return
        cliente.subscribe(self.prefijo + "/+", qos=1)
        print(f"[MQTT] Suscrito a {self.prefijo}/+", flush=True)

    def desconectar(self, _cliente, _userdata, _flags, razon, _properties):
        self.monitor.reiniciar_observacion()
        print(f"[MQTT] Receptor desconectado del broker. {razon}", flush=True)

    def mensaje(self, _cliente, _userdata, mensaje):
        tema = mensaje.topic
        if tema not in (self.prefijo + "/telemetria", self.prefijo + "/estado"):
            return
        try:
            datos = leer_objeto(mensaje.payload)
            if tema == self.prefijo + "/estado":
                if datos.get("dispositivo_id") != DISPOSITIVO or datos.get("estado") not in ("online", "offline"):
                    raise ValueError("mensaje de presencia inválido")
                self.monitor.presencia(datos["estado"])
                return

            if mensaje.retain:
                raise ValueError("la telemetría retenida no se admite")
            validar_telemetria(datos)
            silenciado = datos.get("buzzer_silenciado")
            guardar_csv(self.lecturas, ENCABEZADO_LECTURAS,
                        (fecha(), *(datos[campo] for campo in CAMPOS), silenciado))
            print(f"[RX] {datos['gas_adc']} ADC | {datos['temperatura_c']} °C | "
                  f"{datos['humedad_pct']} % | {datos['clasificacion']} | "
                  f"alarma={datos['alarma_activa']} | umbral={datos['umbral_gas']} | "
                  f"buzzer_silenciado={silenciado if silenciado is not None else 'sin dato'}", flush=True)
            self.monitor.telemetria()
        except (ValueError, RecursionError) as error:
            print(f"[DESCARTADO] {tema} | {error}", flush=True)
        except OSError as error:
            print(f"[CSV] Error al escribir. {error}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--puerto", type=int, default=1883)
    parser.add_argument("--prefijo", default=PREFIJO)
    parser.add_argument("--intervalo", type=int, default=5, help="Intervalo del ESP32 en segundos")
    parser.add_argument("--silencio", type=int, default=15, help="Máximo de silencio en segundos")
    parser.add_argument("--salida", type=Path, default=Path("registros"))
    args = parser.parse_args()
    if args.intervalo < 1 or args.silencio < 3 * args.intervalo:
        parser.error("--silencio debe ser al menos tres veces --intervalo, que debe ser positivo")
    args.salida.mkdir(parents=True, exist_ok=True)
    receptor = Receptor(args.prefijo, args.salida, args.silencio)
    cliente = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    cliente.on_connect_fail = lambda *_: print("[MQTT] Broker inaccesible. Paho reintentará.", flush=True)
    cliente.reconnect_delay_set(min_delay=2, max_delay=60)
    cliente.connect_async(args.host, args.puerto, keepalive=20)

    # Los callbacks corren en el hilo de Paho. El temporizador accede al
    # mismo monitor mediante el bloqueo para serializar cambios de estado.
    bloqueo = Lock()

    def sincronizar(callback):
        def protegido(*argumentos):
            with bloqueo:
                callback(*argumentos)
        return protegido

    cliente.on_connect = sincronizar(receptor.conectar)
    cliente.on_disconnect = sincronizar(receptor.desconectar)
    cliente.on_message = sincronizar(receptor.mensaje)
    cliente.loop_start()
    try:
        while True:
            sleep(0.25)
            with bloqueo:
                try:
                    receptor.monitor.revisar_silencio()
                except OSError as error:
                    print(f"[CSV] Error al escribir evento. {error}", flush=True)
    except KeyboardInterrupt:
        print("[RX] Receptor detenido.", flush=True)
    finally:
        cliente.disconnect()
        cliente.loop_stop()


if __name__ == "__main__":
    main()
