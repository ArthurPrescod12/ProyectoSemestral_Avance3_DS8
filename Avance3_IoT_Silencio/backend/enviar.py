"""Publica una orden o un dato de prueba en el tema elegido."""
import argparse
import sys
from threading import Event

import paho.mqtt.client as mqtt

from receptor import HOST, PREFIJO


def publicar(host, puerto, tema, mensaje):
    plazo = 10
    conexion = Event()
    respuesta = None
    cliente = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, reconnect_on_failure=False)
    cliente.connect_timeout = plazo

    def conectar(_cliente, _datos, _flags, motivo, _propiedades):
        nonlocal respuesta
        respuesta = motivo
        conexion.set()

    cliente.on_connect = conectar
    try:
        cliente.connect(host, puerto)
        cliente.loop_start()
        if not conexion.wait(plazo):
            raise TimeoutError("el broker no confirmó la conexión")
        if respuesta.is_failure:
            raise RuntimeError(f"conexión rechazada por el broker: {respuesta}")

        envio = cliente.publish(tema, mensaje, qos=1, retain=False)
        envio.wait_for_publish(timeout=plazo)
        if not envio.is_published():
            raise TimeoutError("el broker no confirmó la publicación")
    finally:
        cliente.disconnect()
        cliente.loop_stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tema", choices=("orden", "telemetria"))
    parser.add_argument("mensaje", help="Contenido a publicar o - para leer de la entrada estándar")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--puerto", type=int, default=1883)
    parser.add_argument("--prefijo", default=PREFIJO)
    args = parser.parse_args()
    tema = f"{args.prefijo}/{args.tema}"
    mensaje = sys.stdin.read().strip() if args.mensaje == "-" else args.mensaje
    try:
        publicar(args.host, args.puerto, tema, mensaje)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"[ERROR MQTT] {tema} | {error}\n")
    print(f"[ENVIADO] {tema} | {mensaje}")


if __name__ == "__main__":
    main()
