# Avance 3 · Sistema de alarma de detección de gas e incendios domésticos mediante IoT

En el Avance 3 conectamos nuestra estación de Wokwi con el receptor en Python y el dashboard. El ESP32 toma la temperatura y la humedad del DHT22. Para simular el gas usamos un potenciómetro. Cada cinco segundos, el ESP32 manda las lecturas y el nivel de riesgo a HiveMQ por MQTT.

El receptor revisa los datos antes de guardarlos en CSV. También registra si la estación está `ONLINE`, si pasan 15 segundos sin lecturas válidas (`SIN_DATOS`) o si el broker informa que se desconectó (`OFFLINE`). En el dashboard podemos seguir las lecturas en vivo o abrir los CSV de una prueba anterior.

## Lo nuevo del Avance 3

Agregamos el botón azul **Silenciar alarma** para poder pausar el sonido mientras revisamos una alerta. Si la estación está en `PELIGRO`, una pulsación silencia el buzzer por 15 segundos. Durante la pausa, el LED rojo queda fijo y las lecturas siguen llegando. Si el peligro continúa, el buzzer vuelve a sonar. El botón se puede usar una vez por cada episodio de peligro.

## Poner en marcha el circuito en Wokwi

1. Abre nuestro proyecto en Wokwi. Para hacer una prueba aparte, puedes usar **Save a copy**. [Proyecto del equipo](https://wokwi.com/projects/480352064884833281)
2. Para cargar la versión del repositorio, copia `main.py`, `diagram.json` y `mqtt_simple.py` desde `Avance3_IoT_Silencio/dispositivo` a las pestañas del mismo nombre en Wokwi. Si falta `mqtt_simple.py`, crea la pestaña con **New file…**.
3. Revisa `PREFIJO` en `main.py`. Si dice `grupo-demo`, cámbialo por el identificador del grupo. Usa el mismo prefijo en Wokwi, el receptor, el emisor de órdenes y el dashboard.
4. Pulsa **Start the simulation**. Cuando la consola muestre `[MQTT] online`, el ESP32 ya estará conectado al broker.

## Ejecutar el receptor en Visual Studio 2026 o Visual Studio Code

Abre la carpeta principal del repositorio y ejecuta estos comandos en la terminal de PowerShell. En el ejemplo usamos `g01`. Sustitúyelo por el identificador que pusiste en Wokwi. Solo hace falta crear el entorno e instalar las dependencias la primera vez.

```powershell
Set-Location .\Avance3_IoT_Silencio
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$prefijo = "utp/ds8/g01/monitoreo-incendios-a3"
.\.venv\Scripts\python.exe .\backend\receptor.py --prefijo $prefijo
```

Cuando empiecen a llegar mensajes, verás líneas `[RX]`. Con `alarma=True` la estación está en `PELIGRO`. Si además aparece `buzzer_silenciado=True`, el sonido está en pausa.

Las lecturas quedan en `registros/historial_lecturas.csv` y los cambios de comunicación en `registros/eventos_comunicacion.csv`. Si ya existe un historial con el formato anterior, el receptor escribe las nuevas lecturas en `registros/historial_lecturas_con_silencio.csv`. [Pasos para abrir el dashboard](../README.md#abrir-el-dashboard)

## Probar una orden

Deja Wokwi y el receptor en marcha. En otra terminal de PowerShell, desde la carpeta principal, envía una orden para cambiar el umbral de gas a 2200 ADC. Usa el mismo prefijo que configuraste en Wokwi.

```powershell
Set-Location .\Avance3_IoT_Silencio
$prefijo = "utp/ds8/g01/monitoreo-incendios-a3"
'{"accion":"umbral_gas","valor":2200}' | .\.venv\Scripts\python.exe .\backend\enviar.py orden - --prefijo $prefijo
```

`[ENVIADO]` aparece cuando HiveMQ confirma que recibió el mensaje. En Wokwi, `[ORDEN APLICADA]` confirma que el ESP32 cambió el umbral. También puedes comprobar el valor de 2200 en la siguiente lectura del receptor.

## Probar el botón de silencio

Si cambiaste el umbral en la prueba anterior, reinicia la simulación para volver al valor inicial de 2800 ADC. Deja el DHT22 en 27 °C.

1. Sube el potenciómetro a 800. La estación pasa a `PELIGRO`, el LED rojo parpadea y se escucha el buzzer.
2. Mantén pulsado **Silenciar alarma** alrededor de 0,2 segundos. También puedes usar la tecla **S** con el circuito enfocado. El buzzer se apaga y el LED rojo queda fijo. En el receptor debe aparecer `buzzer_silenciado=True` en la siguiente lectura.
3. Deja el potenciómetro en 800 y pulsa otra vez antes de que terminen los 15 segundos. Comprueba que el buzzer vuelva a sonar al terminar la pausa original.
4. Baja el potenciómetro a 200 y espera a que aparezca `NORMAL`. Súbelo otra vez a 800. Ahora puedes volver a usar el botón porque empezó otro episodio de peligro.
5. En ese nuevo episodio, pulsa el botón y baja el potenciómetro a 200 antes de que termine la pausa. La estación vuelve a `NORMAL` y el buzzer queda apagado.

## Cómo funciona el botón en el código

Conectamos el pulsador entre GPIO23 y GND. Con `Pin.PULL_UP`, el ESP32 lee `1` cuando el botón está suelto y `0` cuando lo presionamos. Esperamos que el valor se mantenga estable durante 30 ms para evitar que el rebote del contacto registre una pulsación varias veces.

Para contar los 15 segundos usamos `ticks_add` y `ticks_diff`. Revisamos el tiempo en cada vuelta del programa, así el ESP32 puede seguir leyendo los sensores y enviando datos durante la pausa. [Referencia del pulsador en Wokwi](https://docs.wokwi.com/parts/wokwi-pushbutton)

## Pruebas del avance

Probamos la lectura normal, una orden válida y una inválida, el rechazo de datos incorrectos y la recuperación después de un corte de Wi-Fi. También comprobamos qué pasa al reiniciar, al dejar de publicar con la estación conectada y al detener la simulación. La tabla con los resultados y las capturas está en el informe. [Informe del Avance 3](../dist/evidencia/informe.pdf)
