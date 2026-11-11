# Avance 3 con botón para silenciar la alarma

El botón azul pausa el buzzer durante 15 segundos una vez por episodio de PELIGRO. Durante ese tiempo, el LED rojo queda fijo y el ESP32 sigue midiendo y enviando telemetría. Si el peligro continúa, el buzzer vuelve a sonar con su patrón de tres pulsos. Cuando la lectura baja de PELIGRO, el botón queda habilitado para el próximo episodio.

## Cargar la estación en Wokwi

1. Abre el proyecto del avance 3 en Wokwi. Si vas a preparar una prueba aparte, usa **Save a copy**. [Proyecto del equipo](https://wokwi.com/projects/480352064884833281)
2. Copia el contenido de `dispositivo/main.py` y `dispositivo/diagram.json` a las pestañas del mismo nombre. En el menú de pestañas, usa **New file…** para crear `mqtt_simple.py` y pegar el contenido de la copia local. Si ya existe, reemplaza su contenido.
3. Cambia `grupo-demo` en `PREFIJO` por el identificador de tu grupo. Usa el mismo prefijo en el receptor y en el emisor de órdenes.
4. Pulsa **Start the simulation**. El botón queda cableado entre GPIO23 y GND. Puedes mantenerlo pulsado alrededor de 0.2 s con el ratón o con la tecla **S** cuando el circuito tenga el foco. [Referencia del pulsador](https://docs.wokwi.com/parts/wokwi-pushbutton)

## Ejecutar el receptor en Visual Studio 2026

Abre la carpeta principal del repositorio con **Archivo → Abrir → Carpeta**. Desde la terminal integrada de PowerShell, entra a `Avance3_IoT_Silencio`, instala las dependencias y arranca el receptor. Sustituye `g01` por el grupo configurado en Wokwi.

```powershell
Set-Location .\Avance3_IoT_Silencio
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$prefijo = "utp/ds8/g01/monitoreo-incendios-a3"
.\.venv\Scripts\python.exe backend\receptor.py --prefijo $prefijo
```

En la salida del receptor, `alarma=True` indica PELIGRO y `buzzer_silenciado=True` indica que el botón pausó el sonido. Durante el silencio la estación conserva su estado de comunicación ONLINE mientras el receptor siga recibiendo lecturas. El campo nuevo se guarda en el CSV de lecturas. Si el directorio ya contiene un historial con el encabezado anterior, las lecturas nuevas se escriben en `registros/historial_lecturas_con_silencio.csv`.

En otra terminal de PowerShell, entra a `Avance3_IoT_Silencio` y usa el mismo prefijo para enviar una orden.

```powershell
Set-Location .\Avance3_IoT_Silencio
$prefijo = "utp/ds8/g01/monitoreo-incendios-a3"
'{"accion":"umbral_gas","valor":2200}' | .\.venv\Scripts\python.exe .\backend\enviar.py orden - --prefijo $prefijo
```

`[ENVIADO]` indica que el broker confirmó la publicación. La consola de Wokwi muestra `[ORDEN APLICADA]` cuando el ESP32 recibe y aplica el nuevo umbral.

## Demostrar la función

| Paso | Resultado esperado |
| --- | --- |
| Deja el DHT22 en 27 °C y sube el potenciómetro a 800. | La lectura supera el umbral de 2800 ADC. El LED rojo y el buzzer pulsan. |
| Pulsa **Silenciar alarma**. | El buzzer se apaga, el LED rojo queda fijo y la consola de Wokwi indica 15 s de silencio. El receptor muestra `PELIGRO`, `alarma=True` y `buzzer_silenciado=True` en la siguiente lectura. |
| Mantén el potenciómetro en 800 y vuelve a pulsar antes de que venza el plazo. | La segunda pulsación no prolonga la pausa. El buzzer vuelve a sonar al cumplirse los 15 s. |
| Baja el potenciómetro a 200 y espera a que se muestre NORMAL. Luego súbelo a 800. | La alerta nueva vuelve a sonar. El botón se puede usar una vez en este episodio. |
| Pulsa el botón y baja el potenciómetro a 200 antes de que venza la pausa. | La estación vuelve a NORMAL y queda en silencio cuando se cumple el plazo. |

## Cómo se implementa

El pulsador conecta GPIO23 a tierra cuando se presiona. MicroPython usa `Pin.PULL_UP` para leer un 1 en reposo y un 0 al presionar. El programa exige un nivel estable durante al menos 30 ms y actúa solo cuando detecta la transición a 0. El plazo de 15 s se calcula con `ticks_add` y se comprueba con `ticks_diff` en el bucle principal. De ese modo, el temporizador permite que continúen las lecturas y el intercambio MQTT.
