"""Estación ambiental ESP32 con alarma local y telemetría MQTT."""
import dht
import json
import network
import select
from machine import ADC, PWM, Pin
from time import sleep_ms, ticks_add, ticks_diff, ticks_ms

from mqtt_simple import MQTTClient, MQTTException

BROKER = "broker.hivemq.com"
PUERTO = 1883
PREFIJO = "utp/ds8/grupo-demo/monitoreo-incendios-a3"
DISPOSITIVO = "ESP32_ESTACION_01"
INTERVALO_S = 5
ASOCIACION_WIFI_MS = 30000
CORTE_WIFI_PRUEBA_S = 0  # 25 para probar un corte de Wi-Fi después de 10 s en línea.

ESTADO = (PREFIJO + "/estado").encode()
TELEMETRIA = (PREFIJO + "/telemetria").encode()
ORDEN = (PREFIJO + "/orden").encode()
UMBRAL_INICIAL = 2800
SILENCIO_BUZZER_MS = 15000
ANTIRREBOTE_MS = 30


def estado_json(estado):
    return json.dumps({"dispositivo_id": DISPOSITIVO, "estado": estado}).encode()


def clasificar(gas, temperatura, umbral):
    if gas >= umbral or temperatura >= 40:
        return "PELIGRO"
    if gas >= 1500 or temperatura >= 32:
        return "ADVERTENCIA"
    return "NORMAL"


class Estacion:
    def __init__(self):
        self.sensor = dht.DHT22(Pin(15))
        self.gas = ADC(Pin(34))
        self.gas.atten(ADC.ATTN_11DB)
        self.rojo = Pin(4, Pin.OUT)
        self.verde = Pin(2, Pin.OUT)
        self.buzzer = PWM(Pin(18), freq=1000, duty=0)
        self.boton_silencio = Pin(23, Pin.IN, Pin.PULL_UP)
        self.nivel_boton = self.boton_silencio.value()
        self.nivel_estable_boton = self.nivel_boton
        self.cambio_boton_en = ticks_ms()
        self.umbral = UMBRAL_INICIAL
        self.publicar = True
        self.temperatura = 0
        self.humedad = 0
        self.gas_adc = 0
        self.muestra_valida = False
        self.clasificacion = "NORMAL"
        self.inicio_alarma = None
        self.fin_silencio = None
        self.silencio_usado = False
        self.proxima_lectura = ticks_ms()

    def ordenar(self, tema, mensaje):
        if tema != ORDEN:
            return
        try:
            if len(mensaje) > 256:
                raise ValueError("mensaje demasiado largo")
            datos = json.loads(mensaje.decode())
            if type(datos) is not dict or set(datos) != {"accion", "valor"}:
                raise ValueError("se requieren accion y valor")
            accion = datos["accion"]
            valor = datos["valor"]
            if accion == "umbral_gas" and type(valor) is int and 1501 <= valor <= 4095:
                self.umbral = valor
                # La telemetría puede publicarse en el mismo ciclo que la orden.
                self.actualizar(ticks_ms())
            elif accion == "publicar" and type(valor) is bool:
                self.publicar = valor
            else:
                raise ValueError("acción, tipo o rango inválido")
            print("[ORDEN APLICADA]", accion, valor)
        except (ValueError, RuntimeError) as error:
            print("[ORDEN RECHAZADA]", error)

    def detectar_pulsacion(self, ahora):
        nivel = self.boton_silencio.value()
        if nivel != self.nivel_boton:
            self.nivel_boton = nivel
            self.cambio_boton_en = ahora
        if nivel != self.nivel_estable_boton and ticks_diff(ahora, self.cambio_boton_en) >= ANTIRREBOTE_MS:
            self.nivel_estable_boton = nivel
            return nivel == 0
        return False

    def actualizar(self, ahora):
        if ticks_diff(ahora, self.proxima_lectura) >= 0:
            self.proxima_lectura = ticks_add(ahora, 2200)
            self.muestra_valida = False
            try:
                self.gas_adc = self.gas.read()
                self.sensor.measure()
                self.temperatura = self.sensor.temperature()
                self.humedad = self.sensor.humidity()
                self.muestra_valida = True
            except OSError as error:
                print("[SENSOR]", error)

        self.clasificacion = clasificar(self.gas_adc, self.temperatura, self.umbral)
        peligro = self.clasificacion == "PELIGRO"
        pulsado = self.detectar_pulsacion(ahora)
        if peligro and self.inicio_alarma is None:
            self.inicio_alarma = ahora
        elif not peligro:
            self.inicio_alarma = None
            self.fin_silencio = None
            self.silencio_usado = False

        if peligro and pulsado and not self.silencio_usado:
            self.fin_silencio = ticks_add(ahora, SILENCIO_BUZZER_MS)
            self.silencio_usado = True
            print("[ALARMA] Buzzer silenciado por", SILENCIO_BUZZER_MS // 1000, "s")
        if self.fin_silencio is not None and ticks_diff(ahora, self.fin_silencio) >= 0:
            self.fin_silencio = None
            self.inicio_alarma = ahora
            print("[ALARMA] Buzzer reactivado: persiste el peligro")

        tono = False
        silenciado = self.fin_silencio is not None
        if peligro and not silenciado:
            fase = ticks_diff(ahora, self.inicio_alarma) % 1250
            tono = fase < 900 and fase % 350 < 200
        self.buzzer.duty(512 if tono else 0)
        advertencia = self.clasificacion == "ADVERTENCIA"
        self.rojo.value(tono or advertencia or silenciado)
        self.verde.value(not peligro)

    def telemetria(self):
        return json.dumps({
            "dispositivo_id": DISPOSITIVO,
            "gas_adc": self.gas_adc,
            "temperatura_c": self.temperatura,
            "humedad_pct": self.humedad,
            "clasificacion": self.clasificacion,
            "alarma_activa": self.clasificacion == "PELIGRO",
            "buzzer_silenciado": self.fin_silencio is not None,
            "umbral_gas": self.umbral,
        }).encode()


class Conexion:
    def __init__(self, estacion):
        self.estacion = estacion
        self.wifi = network.WLAN(network.STA_IF)
        self.wifi.active(True)
        self.cliente = None
        self.sondeo = None
        self.asociando = False
        self.intento = ticks_ms()
        self.espera = 2
        self.ping_pendiente = None
        self.cortar_en = None
        self.restaurar_en = None
        self.prueba_realizada = False

    def cerrar(self):
        if self.cliente and self.cliente.sock:
            self.cliente.sock.close()
        self.cliente = None
        self.sondeo = None

    def reintentar(self, error):
        self.cerrar()
        print("[RED] Sin conexión. Reintento en", self.espera, "s.", error)
        self.intento = ticks_add(ticks_ms(), self.espera * 1000)
        self.espera = min(self.espera * 2, 60)

    def conectar_mqtt(self):
        cliente_id = "a3-%08x" % sum(
            (indice + 1) * byte for indice, byte in enumerate(PREFIJO.encode())
        )
        self.cliente = MQTTClient(cliente_id.encode(), BROKER, port=PUERTO, keepalive=10)
        self.cliente.set_last_will(ESTADO, estado_json("offline"), retain=True, qos=1)
        self.cliente.set_callback(self.estacion.ordenar)
        self.cliente.connect(timeout=3)
        self.cliente.subscribe(ORDEN, qos=1)
        self.cliente.publish(ESTADO, estado_json("online"), retain=True, qos=1)

        self.sondeo = select.poll()
        self.sondeo.register(self.cliente.sock, select.POLLIN)
        ahora = ticks_ms()
        self.espera = 2
        self.publicar_en = ahora
        self.ping_en = ticks_add(ahora, 4000)
        self.ping_pendiente = None
        if CORTE_WIFI_PRUEBA_S and not self.prueba_realizada:
            self.cortar_en = ticks_add(ahora, 10000)
        print("[MQTT] online |", PREFIJO)

    def atender(self, ahora):
        if self.cortar_en is not None and ticks_diff(ahora, self.cortar_en) >= 0:
            self.cortar_en = None
            self.prueba_realizada = True
            self.wifi.active(False)
            self.restaurar_en = ticks_add(ahora, CORTE_WIFI_PRUEBA_S * 1000)
            self.reintentar("Corte de Wi-Fi de prueba")
        if self.restaurar_en is not None:
            if ticks_diff(ahora, self.restaurar_en) < 0:
                return
            self.wifi.active(True)
            self.restaurar_en = None
            print("[PRUEBA] Wi-Fi habilitado otra vez")

        try:
            if self.cliente:
                if not self.wifi.isconnected():
                    raise OSError("Wi-Fi perdido")
                self.intercambiar(ahora)
                return

            if self.wifi.isconnected():
                self.asociando = False
                if ticks_diff(ahora, self.intento) >= 0:
                    self.conectar_mqtt()
            elif self.asociando:
                if ticks_diff(ahora, self.limite_wifi) >= 0:
                    self.asociando = False
                    self.wifi.disconnect()
                    self.reintentar("Tiempo de asociación Wi-Fi agotado")
            elif ticks_diff(ahora, self.intento) >= 0:
                print("[WIFI] Conectando a Wokwi-GUEST")
                self.wifi.connect("Wokwi-GUEST", "")
                self.asociando = True
                self.limite_wifi = ticks_add(ticks_ms(), ASOCIACION_WIFI_MS)
        except (OSError, MQTTException, AssertionError, IndexError) as error:
            self.reintentar(error)

    def intercambiar(self, ahora):
        for _, eventos in self.sondeo.poll(0):
            if eventos & (select.POLLERR | select.POLLHUP):
                raise OSError("Socket MQTT cerrado")
            if eventos & select.POLLIN and self.cliente.wait_msg() == 0xD0:
                self.ping_pendiente = None
        if self.ping_pendiente is not None and ticks_diff(ahora, self.ping_pendiente) >= 0:
            raise OSError("El broker no respondió al ping")
        if self.ping_pendiente is None and ticks_diff(ahora, self.ping_en) >= 0:
            self.cliente.ping()
            self.ping_pendiente = ticks_add(ahora, 5000)
            self.ping_en = ticks_add(ahora, 4000)

        if ticks_diff(ahora, self.publicar_en) >= 0:
            self.publicar_en = ticks_add(ahora, INTERVALO_S * 1000)
            if self.estacion.publicar and self.estacion.muestra_valida:
                mensaje = self.estacion.telemetria()
                self.cliente.publish(TELEMETRIA, mensaje)
                print("[TX]", mensaje.decode())


def main():
    estacion = Estacion()
    conexion = Conexion(estacion)
    try:
        while True:
            ahora = ticks_ms()
            estacion.actualizar(ahora)
            conexion.atender(ahora)
            sleep_ms(40)
    finally:
        conexion.cerrar()
        estacion.buzzer.duty(0)


if __name__ == "__main__":
    main()
